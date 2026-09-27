// soundcheck-vst3-host: the helper process that loads one VST3 Plugin and runs
// it, so that a Plugin that crashes takes down only this process, never the
// Desktop App or the song.
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
//   load <bundle> <cid> <rate> <max frames>
//                                   ok <effect|instrument> <inputs> <outputs>
//   params                          param <id> <title> <units> <default> <steps> <flags>
//   set <id> <value>                the controller's side of a setting
//   get-state                       ok <component state> <controller state>, in hex
//   set-state <component> <controller>
//   editor                          ok <width> <height> <resizable> <platform types>
//   quit
//
// Everything here runs on the main thread except the block loop, which runs on
// its own thread from `load` until `quit`.
//
// When a Plugin crashes, a signal handler tells the Desktop App through the
// shared memory before the process dies, so the App knows within the block
// rather than when the system gets round to ending the process (which, when
// it writes a core dump first, can take a tenth of a second or more).

#include "shared.h"

#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/gui/iplugview.h"
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

#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <thread>
#include <unistd.h>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

FILE* protocol = nullptr;

void reply (const std::string& line)
{
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

// What a Plugin is told its host is.
class Host : public HostApplication
{
public:
	tresult PLUGIN_API getName (String128 name) override
	{
		return Steinberg::Vst::StringConvert::convert ("Soundcheck", name) ? kResultTrue : kInternalError;
	}
};

// Settings the Plugin changes itself, from its own window. The Desktop App
// would record them in the Project; the spike only accepts them.
class ComponentHandler : public IComponentHandler
{
public:
	tresult PLUGIN_API beginEdit (ParamID) override { return kResultOk; }
	tresult PLUGIN_API performEdit (ParamID, ParamValue) override { return kResultOk; }
	tresult PLUGIN_API endEdit (ParamID) override { return kResultOk; }
	tresult PLUGIN_API restartComponent (int32) override { return kResultOk; }
	tresult PLUGIN_API queryInterface (const TUID, void** obj) override
	{
		*obj = nullptr;
		return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1; }
	uint32 PLUGIN_API release () override { return 1; }
};

Host host;
ComponentHandler componentHandler;
ScShared* block = nullptr;

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

// The block loop: one block per `go`, straight from and into shared memory.
void alternateStack ();

void runBlocks (Loaded* loaded)
{
	alternateStack ();
	ParameterChanges changes (SC_MAX_PARAM_CHANGES);
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

	while (true)
	{
		while (sem_wait (&block->go) != 0 && errno == EINTR)
		{
		}
		if (block->quit)
			return;
		uint32 seq = block->seq;
		uint32 frames = std::min<uint32> (block->frames, SC_MAX_FRAMES);
		data.numSamples = static_cast<int32> (frames);

		changes.clearQueue ();
		for (uint32 i = 0; i < std::min<uint32> (block->param_change_count, SC_MAX_PARAM_CHANGES); ++i)
		{
			auto& change = block->param_changes[i];
			int32 queueIndex = 0, pointIndex = 0;
			if (auto* queue = changes.addParameterData (change.id, queueIndex))
				queue->addPoint (static_cast<int32> (change.offset), change.value, pointIndex);
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
		sem_post (&block->done);
	}
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

	ProcessSetup setup {kRealtime, kSample32, maxFrames, rate};
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
		       std::to_string (info.defaultNormalizedValue) + "\t" + std::to_string (info.stepCount) +
		       "\t" + std::to_string (info.flags));
	}
	ok ();
}

void set (const std::vector<std::string>& args)
{
	if (!plugin || !plugin->controller || args.size () < 3)
		return err ("set needs a loaded Plugin, an id and a value");
	plugin->controller->setParamNormalized (static_cast<ParamID> (std::stoul (args[1])),
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

// What the Plugin's own window would need. Opening it (`attached` on a window
// of this process's own) needs a display, which the spike has none of; the ADR
// says how the Desktop App does it.
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

void quit ()
{
	if (plugin)
	{
		block->quit = 1;
		sem_post (&block->go);
		plugin->blocks.join ();
		plugin->processor->setProcessing (false);
		plugin->component->setActive (false);
		plugin->data.unprepare ();
	}
	ok ();
	std::fflush (protocol);
	// Whatever the Plugin does as it unloads is its own business: the song no
	// longer needs this process.
	_exit (0);
}

// Only async-signal-safe calls: the Plugin has just broken this process.
void onCrash (int signal)
{
	if (block)
	{
		block->status = SC_STATUS_CRASHED;
		block->done_seq = block->seq;
		sem_post (&block->done);
	}
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

} // namespace

int main (int argc, char** argv)
{
	// Die with the Desktop App rather than outlive it.
	prctl (PR_SET_PDEATHSIG, SIGKILL);
	std::signal (SIGPIPE, SIG_IGN);

	int protocolFd = dup (STDOUT_FILENO);
	dup2 (STDERR_FILENO, STDOUT_FILENO);
	protocol = fdopen (protocolFd, "w");

	if (argc == 3 && std::strcmp (argv[1], "--shm") == 0)
	{
		int fd = shm_open (argv[2], O_RDWR, 0);
		if (fd < 0)
		{
			err ("could not open the shared memory");
			return 1;
		}
		void* memory = mmap (nullptr, sizeof (ScShared), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
		close (fd);
		if (memory == MAP_FAILED)
		{
			err ("could not map the shared memory");
			return 1;
		}
		block = static_cast<ScShared*> (memory);
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

	std::string line;
	while (std::getline (std::cin, line))
	{
		auto args = fields (line);
		if (args.empty ())
			continue;
		const auto& command = args[0];
		if (command == "scan" && args.size () > 1)
			scan (args[1]);
		else if (command == "load")
			load (args);
		else if (command == "params")
			params ();
		else if (command == "set")
			set (args);
		else if (command == "get-state")
			getState ();
		else if (command == "set-state")
			setState (args);
		else if (command == "editor")
			editor ();
		else if (command == "quit")
			quit ();
		else
			err ("unknown command " + clean (command));
	}
	// stdin closed: the Desktop App has gone.
	_exit (0);
}
