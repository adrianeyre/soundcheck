// soundcheck-vst3-host: the helper process that loads one VST3 Plugin and runs
// it for the Desktop App (ADR 0008), so that a Plugin that crashes takes down
// only this process, never the Desktop App or the song.
//
//   soundcheck-vst3-host                 answers `scan` only
//   soundcheck-vst3-host --shm <name>    also `load`s a Plugin and processes
//                                        blocks through the shared memory
//
// Commands come in on stdin, one per line, fields separated by tabs. Each is
// answered on the protocol pipe (what stdout was at startup) by any number of
// data lines and then one `ok` or `err` line. stdout itself is pointed at
// stderr, so whatever a Plugin prints can't corrupt the protocol.
//
//   scan <bundle>                   class <cid> <category> <name> <vendor> <version> <sub-categories>
//   load <bundle> <cid> <rate> <max frames> [realtime|offline]
//                                   ok <effect|instrument> <inputs> <outputs>
//   params                          param <id> <title> <units> <default> <steps> <flags> <value>
//   text <id> <value>               ok <the Plugin's own text for that value>
//   set <id> <value>                the controller's side of a setting
//   get-state                       ok <component state> <controller state>, in hex
//   set-state <component> <controller>
//   editor                          ok <width> <height> <resizable|fixed> <platform types>
//   open-editor <title> <owner> [<x> <y>]
//                                   opens the Plugin's own window (Windows only so far)
//   close-editor                    ok <x> <y>, where it was
//   quit
//
// Between replies, and never inside one, the helper also sends what happens in
// the Plugin's own window as it happens, each line starting `notice`:
//
//   notice begin <id>   notice edit <id> <value>   notice end <id>
//   notice restart <flags>          notice closed <x> <y>
//
// Commands are read on a thread of their own and run on the main thread, which
// is also where the Plugin's window lives. The block loop runs on a third
// thread from `load` until `quit`. When stdin closes, the Desktop App has gone,
// and so does the helper, even if the Plugin has hung its main thread.
//
// When a Plugin crashes, the crash handler tells the Desktop App through the
// shared memory before the process dies, so the App knows within the block
// rather than when the system gets round to ending the process.

#include "shared.h"

#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
// windows.h first: avrt.h uses its types and macros without including it.
#include <windows.h>

#include <avrt.h>
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <pthread.h>
#include <semaphore.h>
#include <sys/mman.h>
#include <unistd.h>
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

// --- The protocol ---------------------------------------------------------

FILE* protocol = nullptr;
std::mutex protocolLock;

void reply (const std::string& line)
{
	std::lock_guard<std::mutex> guard (protocolLock);
	std::fputs (line.c_str (), protocol);
	std::fputc ('\n', protocol);
	std::fflush (protocol);
}

void ok (const std::string& rest = "") { reply (rest.empty () ? "ok" : "ok\t" + rest); }
void err (const std::string& why) { reply ("err\t" + why); }

std::vector<std::string> fields (const std::string& line)
{
	std::vector<std::string> out;
	std::stringstream stream (line);
	std::string field;
	while (std::getline (stream, field, '\t'))
		out.push_back (field);
	return out;
}

// Tabs and newlines can't appear in a field.
std::string clean (std::string text)
{
	for (auto& c : text)
		if (c == '\t' || c == '\n' || c == '\r')
			c = ' ';
	return text;
}

std::string toHex (const void* data, size_t size)
{
	static const char digits[] = "0123456789abcdef";
	std::string out;
	out.reserve (size * 2);
	auto bytes = static_cast<const unsigned char*> (data);
	for (size_t i = 0; i < size; ++i)
	{
		out.push_back (digits[bytes[i] >> 4]);
		out.push_back (digits[bytes[i] & 15]);
	}
	return out;
}

bool fromHex (const std::string& hex, std::vector<char>& out)
{
	if (hex.size () % 2)
		return false;
	out.clear ();
	out.reserve (hex.size () / 2);
	for (size_t i = 0; i < hex.size (); i += 2)
	{
		char pair[3] = {hex[i], hex[i + 1], 0};
		char* end = nullptr;
		out.push_back (static_cast<char> (std::strtoul (pair, &end, 16)));
		if (end != pair + 2)
			return false;
	}
	return true;
}

std::string number (double value)
{
	char text[32];
	std::snprintf (text, sizeof (text), "%.17g", value);
	return text;
}

// --- The shared memory, and each OS's part of it ---------------------------

ScShared* block = nullptr;

#ifdef _WIN32
HANDLE goEvent = nullptr;
HANDLE doneEvent = nullptr;

std::wstring wide (const std::string& text)
{
	if (text.empty ())
		return {};
	int size = MultiByteToWideChar (CP_UTF8, 0, text.data (), static_cast<int> (text.size ()), nullptr, 0);
	std::wstring out (static_cast<size_t> (size), L'\0');
	MultiByteToWideChar (CP_UTF8, 0, text.data (), static_cast<int> (text.size ()), out.data (), size);
	return out;
}

// The memory is a named file mapping, and *go* and *done* two named auto-reset
// events beside it, all three named by the Desktop App at random.
bool openShared (const std::string& name)
{
	HANDLE mapping = OpenFileMappingW (FILE_MAP_ALL_ACCESS, FALSE, wide (name).c_str ());
	if (!mapping)
		return false;
	void* memory = MapViewOfFile (mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof (ScShared));
	CloseHandle (mapping);
	goEvent = OpenEventW (SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, wide (name + "-go").c_str ());
	doneEvent = OpenEventW (SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, wide (name + "-done").c_str ());
	if (!memory || !goEvent || !doneEvent)
		return false;
	block = static_cast<ScShared*> (memory);
	return true;
}

void waitGo () { WaitForSingleObject (goEvent, INFINITE); }
void postDone () { SetEvent (doneEvent); }
void postGo () { SetEvent (goEvent); }
#else
// The memory is POSIX shared memory, and *go* and *done* process-shared
// semaphores inside it, which the Desktop App has initialised.
bool openShared (const std::string& name)
{
	int fd = shm_open (name.c_str (), O_RDWR, 0);
	if (fd < 0)
		return false;
	void* memory = mmap (nullptr, sizeof (ScShared), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	close (fd);
	if (memory == MAP_FAILED)
		return false;
	block = static_cast<ScShared*> (memory);
	return true;
}

sem_t* goSemaphore () { return reinterpret_cast<sem_t*> (block->go); }
sem_t* doneSemaphore () { return reinterpret_cast<sem_t*> (block->done); }
void waitGo ()
{
	while (sem_wait (goSemaphore ()) != 0 && errno == EINTR)
	{
	}
}
void postDone () { sem_post (doneSemaphore ()); }
void postGo () { sem_post (goSemaphore ()); }
#endif

// --- Crashes ---------------------------------------------------------------

// Only what is safe in a crash: the Plugin has just broken this process.
void markCrashed ()
{
	if (block)
	{
		block->status = SC_STATUS_CRASHED;
		block->done_seq = block->seq;
		postDone ();
	}
}

#ifdef _WIN32
LONG WINAPI onCrash (EXCEPTION_POINTERS*)
{
	markCrashed ();
	// Ends the process at once, without Windows Error Reporting's dialog.
	return EXCEPTION_EXECUTE_HANDLER;
}

void onAbort (int)
{
	markCrashed ();
	TerminateProcess (GetCurrentProcess (), 3);
}

// Room to run the handler after a stack overflow, for each thread that runs
// Plugin code.
void alternateStack ()
{
	ULONG guarantee = 64 * 1024;
	SetThreadStackGuarantee (&guarantee);
}

void catchCrashes ()
{
	SetErrorMode (SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	_set_abort_behavior (0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
	alternateStack ();
	SetUnhandledExceptionFilter (onCrash);
	std::signal (SIGABRT, onAbort);
}
#else
void onCrash (int signal)
{
	markCrashed ();
	// Then die of it as before, so the system still sees the crash.
	std::signal (signal, SIG_DFL);
	raise (signal);
}

// Gives the calling thread a stack of its own for signal handlers, so a stack
// overflow can still be reported. Each thread that runs Plugin code needs one.
void alternateStack ()
{
	thread_local char stack[64 * 1024];
	stack_t alternate {};
	alternate.ss_sp = stack;
	alternate.ss_size = sizeof (stack);
	sigaltstack (&alternate, nullptr);
}

void catchCrashes ()
{
	alternateStack ();
	struct sigaction action {};
	action.sa_handler = onCrash;
	action.sa_flags = SA_ONSTACK | SA_RESETHAND;
	sigemptyset (&action.sa_mask);
	for (int signal : {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT})
		sigaction (signal, &action, nullptr);
}
#endif

// The block thread runs at the audio thread's priority where the system lets
// it: MMCSS "Pro Audio" on Windows, SCHED_FIFO on Linux (which needs rights a
// desktop user usually lacks, so failing is fine).
void audioPriority ()
{
#ifdef _WIN32
	DWORD task = 0;
	AvSetMmThreadCharacteristicsW (L"Pro Audio", &task);
#else
	sched_param param {};
	param.sched_priority = 70;
	pthread_setschedparam (pthread_self (), SCHED_FIFO, &param);
#endif
}

// --- The main thread's queue of commands -----------------------------------

std::mutex linesLock;
std::condition_variable linesReady;
std::deque<std::string> lines;
#ifdef _WIN32
HANDLE lineEvent = nullptr;
#endif

// Not a command anyone can send: every line sent ends at its newline.
const std::string endOfCommands = "\n";

void readCommands ()
{
	std::string line;
	while (std::getline (std::cin, line))
	{
		{
			std::lock_guard<std::mutex> guard (linesLock);
			lines.push_back (std::move (line));
		}
		linesReady.notify_one ();
#ifdef _WIN32
		SetEvent (lineEvent);
#endif
	}
	// stdin closed: the Desktop App has gone, and the Plugin's song with it.
	// The main thread ends the process once it has run what came before;
	// this thread does, if the Plugin has hung the main thread.
	{
		std::lock_guard<std::mutex> guard (linesLock);
		lines.push_back (endOfCommands);
	}
	linesReady.notify_one ();
#ifdef _WIN32
	SetEvent (lineEvent);
#endif
	std::this_thread::sleep_for (std::chrono::seconds (5));
	std::_Exit (0);
}

// Waits a little for a command, running the window's events meanwhile.
bool nextCommand (std::string& line)
{
#ifdef _WIN32
	bool empty = false;
	{
		std::lock_guard<std::mutex> guard (linesLock);
		empty = lines.empty ();
	}
	if (empty)
		MsgWaitForMultipleObjects (1, &lineEvent, FALSE, 30, QS_ALLINPUT);
	MSG message;
	while (PeekMessageW (&message, nullptr, 0, 0, PM_REMOVE))
	{
		TranslateMessage (&message);
		DispatchMessageW (&message);
	}
	std::lock_guard<std::mutex> guard (linesLock);
#else
	std::unique_lock<std::mutex> guard (linesLock);
	linesReady.wait_for (guard, std::chrono::milliseconds (30), [] { return !lines.empty (); });
#endif
	if (lines.empty ())
		return false;
	line = std::move (lines.front ());
	lines.pop_front ();
	return true;
}

// --- Settings passed between the block thread and the main thread ----------

struct Change
{
	ParamID id;
	double value;
};

// Guarded by `changesLock`, which the block thread only ever tries for.
std::mutex changesLock;
std::vector<Change> fromWindow;   // turned in the Plugin's window, for the processor
std::vector<Change> toController; // sent to the processor, for the window to show
std::vector<ParamID> editing;     // held in the window now: the Desktop App's values wait

bool isEditing (ParamID id)
{
	return std::find (editing.begin (), editing.end (), id) != editing.end ();
}

// What a Plugin is told its host is.
class Host : public HostApplication
{
public:
	tresult PLUGIN_API getName (String128 name) override
	{
		return Steinberg::Vst::StringConvert::convert ("Soundcheck", name) ? kResultTrue : kInternalError;
	}
};

// Settings the musician turns in the Plugin's own window: passed to the
// processor with the next block, and up to the Desktop App as notices.
class ComponentHandler : public IComponentHandler
{
public:
	tresult PLUGIN_API beginEdit (ParamID id) override
	{
		{
			std::lock_guard<std::mutex> guard (changesLock);
			if (!isEditing (id))
				editing.push_back (id);
		}
		reply ("notice\tbegin\t" + std::to_string (id));
		return kResultOk;
	}
	tresult PLUGIN_API performEdit (ParamID id, ParamValue value) override
	{
		{
			std::lock_guard<std::mutex> guard (changesLock);
			fromWindow.push_back ({id, value});
		}
		reply ("notice\tedit\t" + std::to_string (id) + "\t" + number (value));
		return kResultOk;
	}
	tresult PLUGIN_API endEdit (ParamID id) override
	{
		{
			std::lock_guard<std::mutex> guard (changesLock);
			editing.erase (std::remove (editing.begin (), editing.end (), id), editing.end ());
		}
		reply ("notice\tend\t" + std::to_string (id));
		return kResultOk;
	}
	tresult PLUGIN_API restartComponent (int32 flags) override
	{
		reply ("notice\trestart\t" + std::to_string (flags));
		return kResultOk;
	}
	tresult PLUGIN_API queryInterface (const TUID iid, void** obj) override
	{
		if (FUnknownPrivate::iidEqual (iid, IComponentHandler::iid) ||
		    FUnknownPrivate::iidEqual (iid, FUnknown::iid))
		{
			*obj = this;
			return kResultOk;
		}
		*obj = nullptr;
		return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1; }
	uint32 PLUGIN_API release () override { return 1; }
};

Host host;
ComponentHandler componentHandler;

struct Loaded
{
	VST3::Hosting::Module::Ptr module;
	IPtr<PlugProvider> provider;
	IPtr<IComponent> component;
	IPtr<IEditController> controller;
	FUnknownPtr<IAudioProcessor> processor;
	HostProcessData data;
	double sampleRate = 0;
	bool hasInput = false;
	bool offline = false;
	std::thread blocks;
};

Loaded* plugin = nullptr;

void scan (const std::string& path)
{
	std::string error;
	auto module = VST3::Hosting::Module::create (path, error);
	if (!module)
		return err (clean (error));
	for (auto& info : module->getFactory ().classInfos ())
	{
		reply ("class\t" + info.ID ().toString () + "\t" + clean (info.category ()) + "\t" +
		       clean (info.name ()) + "\t" + clean (info.vendor ()) + "\t" +
		       clean (info.version ()) + "\t" + clean (info.subCategoriesString ()));
	}
	ok ();
}

// Puts the main audio bus of `direction` in stereo and turns it on, and every
// other audio bus off. Returns how many channels the main bus ended up with.
int32 mainBusChannels (IComponent& component, BusDirection direction)
{
	int32 count = component.getBusCount (kAudio, direction);
	for (int32 i = 0; i < count; ++i)
		component.activateBus (kAudio, direction, i, i == 0);
	if (count == 0)
		return 0;
	BusInfo info {};
	component.getBusInfo (kAudio, direction, 0, info);
	return info.channelCount;
}

// --- The block loop: one block per *go*, straight from and into the memory -

void runBlocks (Loaded* loaded)
{
	alternateStack ();
	if (!loaded->offline)
		audioPriority ();
	ParameterChanges changes (SC_MAX_PARAM_CHANGES * 2);
	ParameterChanges outputChanges (SC_MAX_PARAM_CHANGES);
	EventList events (SC_MAX_EVENTS);
	ProcessContext context {};
	context.sampleRate = loaded->sampleRate;
	context.tempo = 120;
	context.timeSigNumerator = 4;
	context.timeSigDenominator = 4;
	context.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid;

	HostProcessData& data = loaded->data;
	data.inputParameterChanges = &changes;
	data.outputParameterChanges = &outputChanges;
	data.inputEvents = &events;
	data.processContext = &context;

	// Changes for the main thread that it wasn't free to take yet.
	std::vector<Change> forController;
	forController.reserve (1024);
	std::vector<Change> fromWindowNow;
	fromWindowNow.reserve (256);
	std::vector<ParamID> editingNow;
	editingNow.reserve (32);

	while (true)
	{
		waitGo ();
		if (block->quit)
			return;
		uint32 seq = block->seq;
		uint32 frames = std::min<uint32> (block->frames, SC_MAX_FRAMES);
		data.numSamples = static_cast<int32> (frames);

		// What the window turned since the last block, if the main thread
		// isn't holding the lock; otherwise it waits for the next block.
		fromWindowNow.clear ();
		if (changesLock.try_lock ())
		{
			fromWindowNow.swap (fromWindow);
			fromWindow.clear ();
			editingNow.assign (editing.begin (), editing.end ());
			changesLock.unlock ();
		}

		changes.clearQueue ();
		for (auto& change : fromWindowNow)
		{
			int32 queueIndex = 0, pointIndex = 0;
			if (auto* queue = changes.addParameterData (change.id, queueIndex))
				queue->addPoint (0, change.value, pointIndex);
		}
		for (uint32 i = 0; i < std::min<uint32> (block->param_change_count, SC_MAX_PARAM_CHANGES); ++i)
		{
			auto& change = block->param_changes[i];
			// A setting the musician is holding in the window is theirs.
			if (std::find (editingNow.begin (), editingNow.end (), change.id) != editingNow.end ())
				continue;
			int32 queueIndex = 0, pointIndex = 0;
			if (auto* queue = changes.addParameterData (change.id, queueIndex))
				queue->addPoint (static_cast<int32> (change.offset), change.value, pointIndex);
			if (forController.size () < forController.capacity ())
				forController.push_back ({change.id, change.value});
		}
		outputChanges.clearQueue ();
		events.clear ();
		for (uint32 i = 0; i < std::min<uint32> (block->event_count, SC_MAX_EVENTS); ++i)
		{
			auto& source = block->events[i];
			Event event {};
			event.busIndex = 0;
			event.sampleOffset = static_cast<int32> (source.offset);
			if (source.kind == SC_EVENT_NOTE_ON)
			{
				event.type = Event::kNoteOnEvent;
				event.noteOn = {0, static_cast<int16> (source.pitch), 0, source.velocity, 0, -1};
			}
			else
			{
				event.type = Event::kNoteOffEvent;
				event.noteOff = {0, static_cast<int16> (source.pitch), source.velocity, -1, 0};
			}
			events.addEvent (event);
		}

		if (loaded->hasInput)
		{
			auto& bus = data.inputs[0];
			for (int32 c = 0; c < bus.numChannels; ++c)
				std::memcpy (bus.channelBuffers32[c], block->in[c < 2 ? c : 1], frames * sizeof (float));
		}
		tresult result = loaded->processor->process (data);
		auto& out = data.outputs[0];
		for (int c = 0; c < 2; ++c)
		{
			int32 from = out.numChannels == 0 ? -1 : std::min (c, out.numChannels - 1);
			if (from < 0)
				std::memset (block->out[c], 0, frames * sizeof (float));
			else
				std::memcpy (block->out[c], out.channelBuffers32[from], frames * sizeof (float));
		}
		context.projectTimeSamples += frames;
		context.state |= ProcessContext::kPlaying;

		block->status = result == kResultOk ? SC_STATUS_OK : SC_STATUS_PLUGIN_ERROR;
		block->done_seq = seq;
		postDone ();

		// The Plugin's own changes (a meter, say) and the Desktop App's, for
		// the controller, so its window shows them.
		for (int32 i = 0; i < outputChanges.getParameterCount (); ++i)
		{
			auto* queue = outputChanges.getParameterData (i);
			ParamValue value = 0;
			int32 offset = 0;
			if (queue && queue->getPoint (queue->getPointCount () - 1, offset, value) == kResultOk &&
			    forController.size () < forController.capacity ())
				forController.push_back ({queue->getParameterId (), value});
		}
		if (!forController.empty () && changesLock.try_lock ())
		{
			if (toController.size () < 4096)
				toController.insert (toController.end (), forController.begin (), forController.end ());
			changesLock.unlock ();
			forController.clear ();
		}
	}
}

// Run on the main thread between commands: what went to the processor, told
// to the controller, as a host must.
void updateController ()
{
	if (!plugin || !plugin->controller)
		return;
	std::vector<Change> now;
	{
		std::lock_guard<std::mutex> guard (changesLock);
		now.swap (toController);
	}
	for (auto& change : now)
		plugin->controller->setParamNormalized (change.id, change.value);
}

void load (const std::vector<std::string>& args)
{
	if (!block)
		return err ("this helper was started without shared memory");
	if (plugin)
		return err ("a Plugin is already loaded");
	if (args.size () < 5)
		return err ("load needs a bundle, a class id, a sample rate and a block size");
	double rate = std::atof (args[3].c_str ());
	int32 maxFrames = std::atoi (args[4].c_str ());
	bool offline = args.size () > 5 && args[5] == "offline";
	if (rate <= 0 || maxFrames <= 0 || maxFrames > SC_MAX_FRAMES)
		return err ("bad sample rate or block size");

	auto loaded = std::make_unique<Loaded> ();
	std::string error;
	loaded->module = VST3::Hosting::Module::create (args[1], error);
	if (!loaded->module)
		return err (clean (error));
	auto uid = VST3::UID::fromString (args[2]);
	if (!uid)
		return err ("bad class id");
	VST3::Hosting::ClassInfo found;
	bool present = false;
	for (auto& info : loaded->module->getFactory ().classInfos ())
	{
		if (info.ID () == *uid && info.category () == kVstAudioEffectClass)
		{
			found = info;
			present = true;
		}
	}
	if (!present)
		return err ("the bundle has no audio class with that id");

	loaded->provider = owned (new PlugProvider (loaded->module->getFactory (), found, true));
	if (!loaded->provider->initialize ())
		return err ("the Plugin would not initialise");
	loaded->component = loaded->provider->getComponentPtr ();
	loaded->controller = loaded->provider->getControllerPtr ();
	loaded->processor = FUnknownPtr<IAudioProcessor> (loaded->component);
	if (!loaded->processor)
		return err ("the Plugin has no audio processor");
	if (loaded->controller)
		loaded->controller->setComponentHandler (&componentHandler);

	auto& component = *loaded->component;
	SpeakerArrangement stereo = SpeakerArr::kStereo;
	int32 inputBuses = component.getBusCount (kAudio, kInput);
	loaded->processor->setBusArrangements (&stereo, inputBuses > 0 ? 1 : 0, &stereo, 1);
	int32 inputs = mainBusChannels (component, kInput);
	int32 outputs = mainBusChannels (component, kOutput);
	if (outputs == 0)
		return err ("the Plugin has no audio output");
	if (component.getBusCount (kEvent, kInput) > 0)
		component.activateBus (kEvent, kInput, 0, true);
	loaded->hasInput = inputs > 0;
	loaded->offline = offline;

	ProcessSetup setup {offline ? kOffline : kRealtime, kSample32, maxFrames, rate};
	if (loaded->processor->setupProcessing (setup) != kResultOk)
		return err ("the Plugin refused the sample rate or block size");
	if (component.setActive (true) != kResultOk)
		return err ("the Plugin would not activate");
	loaded->processor->setProcessing (true);
	loaded->data.prepare (component, maxFrames, kSample32);
	loaded->sampleRate = rate;

	bool instrument = found.subCategoriesString ().find ("Instrument") != std::string::npos ||
	                  !loaded->hasInput;
	plugin = loaded.release ();
	plugin->blocks = std::thread (runBlocks, plugin);
	ok (std::string (instrument ? "instrument" : "effect") + "\t" + std::to_string (inputs) +
	    "\t" + std::to_string (outputs));
}

void params ()
{
	if (!plugin || !plugin->controller)
		return err ("no Plugin with a controller is loaded");
	auto& controller = *plugin->controller;
	for (int32 i = 0; i < controller.getParameterCount (); ++i)
	{
		ParameterInfo info {};
		if (controller.getParameterInfo (i, info) != kResultOk)
			continue;
		reply ("param\t" + std::to_string (info.id) + "\t" +
		       clean (Steinberg::Vst::StringConvert::convert (info.title)) + "\t" +
		       clean (Steinberg::Vst::StringConvert::convert (info.units)) + "\t" +
		       number (info.defaultNormalizedValue) + "\t" + std::to_string (info.stepCount) + "\t" +
		       std::to_string (info.flags) + "\t" + number (controller.getParamNormalized (info.id)));
	}
	ok ();
}

void text (const std::vector<std::string>& args)
{
	if (!plugin || !plugin->controller || args.size () < 3)
		return err ("text needs a loaded Plugin, an id and a value");
	String128 out {};
	auto id = static_cast<ParamID> (std::strtoul (args[1].c_str (), nullptr, 10));
	if (plugin->controller->getParamStringByValue (id, std::atof (args[2].c_str ()), out) != kResultOk)
		return err ("the Plugin has no text for that value");
	ok (clean (Steinberg::Vst::StringConvert::convert (out)));
}

void set (const std::vector<std::string>& args)
{
	if (!plugin || !plugin->controller || args.size () < 3)
		return err ("set needs a loaded Plugin, an id and a value");
	plugin->controller->setParamNormalized (static_cast<ParamID> (std::strtoul (args[1].c_str (), nullptr, 10)),
	                                        std::atof (args[2].c_str ()));
	ok ();
}

void getState ()
{
	if (!plugin)
		return err ("no Plugin is loaded");
	auto component = owned (new MemoryStream);
	auto controller = owned (new MemoryStream);
	if (plugin->component->getState (component) != kResultOk)
		return err ("the Plugin would not give its state");
	if (plugin->controller)
		plugin->controller->getState (controller);
	ok (toHex (component->getData (), static_cast<size_t> (component->getSize ())) + "\t" +
	    toHex (controller->getData (), static_cast<size_t> (controller->getSize ())));
}

void setState (const std::vector<std::string>& args)
{
	if (!plugin)
		return err ("no Plugin is loaded");
	std::vector<char> componentBytes, controllerBytes;
	if (args.size () < 2 || !fromHex (args[1], componentBytes) ||
	    !fromHex (args.size () > 2 ? args[2] : "", controllerBytes))
		return err ("set-state needs its state in hex");
	auto component = owned (new MemoryStream);
	auto controller = owned (new MemoryStream);
	int32 written = 0;
	component->write (componentBytes.data (), static_cast<int32> (componentBytes.size ()), &written);
	controller->write (controllerBytes.data (), static_cast<int32> (controllerBytes.size ()), &written);
	component->seek (0, IBStream::kIBSeekSet, nullptr);
	if (plugin->component->setState (component) != kResultOk)
		return err ("the Plugin refused its state");
	if (plugin->controller)
	{
		component->seek (0, IBStream::kIBSeekSet, nullptr);
		plugin->controller->setComponentState (component);
		if (!controllerBytes.empty ())
		{
			controller->seek (0, IBStream::kIBSeekSet, nullptr);
			plugin->controller->setState (controller);
		}
	}
	ok ();
}

// What the Plugin's own window needs, asked without opening it.
void editor ()
{
	if (!plugin || !plugin->controller)
		return err ("no Plugin with a controller is loaded");
	IPtr<IPlugView> view = owned (plugin->controller->createView (ViewType::kEditor));
	if (!view)
		return err ("the Plugin has no window of its own");
	std::string types;
	for (auto type : {kPlatformTypeHWND, kPlatformTypeNSView, kPlatformTypeX11EmbedWindowID})
	{
		if (view->isPlatformTypeSupported (type) == kResultTrue)
			types += (types.empty () ? "" : ",") + std::string (type);
	}
	ViewRect rect {};
	view->getSize (&rect);
	ok (std::to_string (rect.getWidth ()) + "\t" + std::to_string (rect.getHeight ()) + "\t" +
	    (view->canResize () == kResultTrue ? "resizable" : "fixed") + "\t" + types);
}

// --- The Plugin's own window -------------------------------------------------

#ifdef _WIN32
// A captioned top-level window owned by the Desktop App's main window, so it
// stays above it, minimises with it and has no taskbar button (ADR 0008).
class Window : public IPlugFrame
{
public:
	IPtr<IPlugView> view;
	HWND handle = nullptr;
	DWORD style = 0;
	bool resizing = false;

	tresult PLUGIN_API resizeView (IPlugView* from, ViewRect* size) override
	{
		if (!handle || !size)
			return kInvalidArgument;
		RECT rect {0, 0, size->getWidth (), size->getHeight ()};
		AdjustWindowRectExForDpi (&rect, style, FALSE, 0, GetDpiForWindow (handle));
		resizing = true;
		SetWindowPos (handle, nullptr, 0, 0, rect.right - rect.left, rect.bottom - rect.top,
		              SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
		resizing = false;
		from->onSize (size);
		return kResultTrue;
	}
	tresult PLUGIN_API queryInterface (const TUID iid, void** obj) override
	{
		if (FUnknownPrivate::iidEqual (iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual (iid, FUnknown::iid))
		{
			*obj = this;
			return kResultOk;
		}
		*obj = nullptr;
		return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1; }
	uint32 PLUGIN_API release () override { return 1; }
};

Window window;

std::pair<long, long> closeWindow ()
{
	RECT where {};
	if (window.handle)
		GetWindowRect (window.handle, &where);
	if (window.view)
	{
		window.view->setFrame (nullptr);
		window.view->removed ();
		window.view = nullptr;
	}
	if (window.handle)
		DestroyWindow (window.handle);
	window.handle = nullptr;
	return {where.left, where.top};
}

LRESULT CALLBACK windowEvents (HWND handle, UINT message, WPARAM w, LPARAM l)
{
	switch (message)
	{
		case WM_SIZE:
			if (window.view && !window.resizing && window.view->canResize () == kResultTrue)
			{
				ViewRect size {0, 0, LOWORD (l), HIWORD (l)};
				window.view->checkSizeConstraint (&size);
				window.view->onSize (&size);
			}
			return 0;
		case WM_DPICHANGED:
		{
			if (window.view)
			{
				FUnknownPtr<IPlugViewContentScaleSupport> scale (window.view);
				if (scale)
					scale->setContentScaleFactor (static_cast<float> (HIWORD (w)) / 96.0f);
			}
			auto* suggested = reinterpret_cast<RECT*> (l);
			SetWindowPos (handle, nullptr, suggested->left, suggested->top, suggested->right - suggested->left,
			              suggested->bottom - suggested->top, SWP_NOZORDER | SWP_NOACTIVATE);
			return 0;
		}
		case WM_CLOSE:
		{
			auto where = closeWindow ();
			reply ("notice\tclosed\t" + std::to_string (where.first) + "\t" + std::to_string (where.second));
			return 0;
		}
	}
	return DefWindowProcW (handle, message, w, l);
}

void openEditor (const std::vector<std::string>& args)
{
	if (!plugin || !plugin->controller)
		return err ("no Plugin with a controller is loaded");
	if (window.handle)
	{
		ShowWindow (window.handle, SW_SHOWNORMAL);
		SetForegroundWindow (window.handle);
		return ok ();
	}
	std::string title = args.size () > 1 ? args[1] : "Plugin";
	auto owner = reinterpret_cast<HWND> (
	    static_cast<uintptr_t> (args.size () > 2 ? std::strtoull (args[2].c_str (), nullptr, 10) : 0));
	int x = args.size () > 4 ? std::atoi (args[3].c_str ()) : CW_USEDEFAULT;
	int y = args.size () > 4 ? std::atoi (args[4].c_str ()) : CW_USEDEFAULT;

	IPtr<IPlugView> view = owned (plugin->controller->createView (ViewType::kEditor));
	if (!view)
		return err ("the Plugin has no window of its own");
	if (view->isPlatformTypeSupported (kPlatformTypeHWND) != kResultTrue)
		return err ("the Plugin's window can't be shown on Windows");

	static bool registered = false;
	HINSTANCE instance = GetModuleHandleW (nullptr);
	if (!registered)
	{
		WNDCLASSEXW type {};
		type.cbSize = sizeof (type);
		type.lpfnWndProc = windowEvents;
		type.hInstance = instance;
		type.hCursor = LoadCursorW (nullptr, IDC_ARROW);
		type.lpszClassName = L"SoundcheckPluginWindow";
		RegisterClassExW (&type);
		registered = true;
	}
	window.style = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
	if (view->canResize () == kResultTrue)
		window.style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
	ViewRect size {};
	view->getSize (&size);
	window.handle = CreateWindowExW (0, L"SoundcheckPluginWindow", wide (title).c_str (), window.style, x, y,
	                                 size.getWidth (), size.getHeight (), owner, nullptr, instance, nullptr);
	if (!window.handle)
		return err ("could not make a window");
	UINT dpi = GetDpiForWindow (window.handle);
	FUnknownPtr<IPlugViewContentScaleSupport> scale (view);
	if (scale)
		scale->setContentScaleFactor (static_cast<float> (dpi) / 96.0f);
	view->getSize (&size);
	RECT rect {0, 0, size.getWidth (), size.getHeight ()};
	AdjustWindowRectExForDpi (&rect, window.style, FALSE, 0, dpi);
	SetWindowPos (window.handle, nullptr, 0, 0, rect.right - rect.left, rect.bottom - rect.top,
	              SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
	window.view = view;
	view->setFrame (&window);
	if (view->attached (window.handle, kPlatformTypeHWND) != kResultOk)
	{
		closeWindow ();
		return err ("the Plugin wouldn't open its window");
	}
	ShowWindow (window.handle, SW_SHOWNORMAL);
	SetForegroundWindow (window.handle);
	ok ();
}

void closeEditor ()
{
	auto where = closeWindow ();
	ok (std::to_string (where.first) + "\t" + std::to_string (where.second));
}
#else
// ADR 0008's X11 window (and macOS's) comes later: #70 builds Windows first.
void openEditor (const std::vector<std::string>&)
{
	err ("a Plugin's window can only be opened on Windows so far");
}
void closeEditor () { ok ("0\t0"); }
#endif

[[noreturn]] void quit ()
{
	if (plugin)
	{
		block->quit = 1;
		postGo ();
		plugin->blocks.join ();
		plugin->processor->setProcessing (false);
		plugin->component->setActive (false);
		plugin->data.unprepare ();
	}
	ok ();
	std::fflush (protocol);
	// Whatever the Plugin does as it unloads is its own business: the song no
	// longer needs this process.
	std::_Exit (0);
}

void run (const std::string& line)
{
	if (line == endOfCommands)
	{
		std::fflush (protocol);
		std::_Exit (0);
	}
	auto args = fields (line);
	if (args.empty ())
		return;
	const auto& command = args[0];
	if (command == "scan" && args.size () > 1)
		scan (args[1]);
	else if (command == "load")
		load (args);
	else if (command == "params")
		params ();
	else if (command == "text")
		text (args);
	else if (command == "set")
		set (args);
	else if (command == "get-state")
		getState ();
	else if (command == "set-state")
		setState (args);
	else if (command == "editor")
		editor ();
	else if (command == "open-editor")
		openEditor (args);
	else if (command == "close-editor")
		closeEditor ();
	else if (command == "quit")
		quit ();
	else
		err ("unknown command " + clean (command));
}

// The protocol goes to what stdout was at startup, and stdout from now on goes
// to stderr, both the C runtime's and (on Windows) the system's handle.
void takeStdout ()
{
#ifdef _WIN32
	HANDLE original = GetStdHandle (STD_OUTPUT_HANDLE);
	HANDLE copy = nullptr;
	DuplicateHandle (GetCurrentProcess (), original, GetCurrentProcess (), &copy, 0, FALSE,
	                 DUPLICATE_SAME_ACCESS);
	SetStdHandle (STD_OUTPUT_HANDLE, GetStdHandle (STD_ERROR_HANDLE));
	_dup2 (_fileno (stderr), _fileno (stdout));
	protocol = _fdopen (_open_osfhandle (reinterpret_cast<intptr_t> (copy), _O_BINARY), "wb");
#else
	std::signal (SIGPIPE, SIG_IGN);
	int protocolFd = dup (STDOUT_FILENO);
	dup2 (STDERR_FILENO, STDOUT_FILENO);
	protocol = fdopen (protocolFd, "w");
#endif
}

} // namespace

int main (int argc, char** argv)
{
	takeStdout ();
#ifdef _WIN32
	SetProcessDpiAwarenessContext (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	lineEvent = CreateEventW (nullptr, FALSE, FALSE, nullptr);
#endif

	if (argc == 3 && std::strcmp (argv[1], "--shm") == 0)
	{
		if (!openShared (argv[2]))
		{
			err ("could not open the shared memory");
			return 1;
		}
		if (block->magic != SC_SHARED_MAGIC || block->version != SC_SHARED_VERSION)
		{
			err ("the shared memory is not version " + std::to_string (SC_SHARED_VERSION));
			return 1;
		}
	}
	catchCrashes ();

	PluginContextFactory::instance ().setPluginContext (&host);
	ok (std::string ("soundcheck-vst3-host\t") + std::to_string (SC_SHARED_VERSION) + "\t" +
	    std::to_string (sizeof (ScShared)));

	std::thread (readCommands).detach ();
	std::string line;
	while (true)
	{
		while (nextCommand (line))
			run (line);
		updateController ();
	}
}
