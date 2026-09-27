// "Soundcheck Faulty": a stereo gain Effect that crashes or hangs when told
// to, so the Desktop App's tests can show a Plugin's crash or hang doesn't take
// the song down. Ported from the #69 spike's; built only for tests, never
// shipped.
//
// Settings: Gain (id 0, 0 to 1, as a plain factor, shown in dB), Crash (id 1),
// Hang (id 2), Slow (id 3) and Poke (id 4). Setting Crash above 0.5
// dereferences a null pointer in the next block; setting Hang above 0.5 never
// returns from the next block; Slow makes every block take that many tenths of
// a second longer. Poke, set on the controller, turns Gain to a quarter
// through `beginEdit`, `performEdit` and `endEdit`, as a knob in its window
// would. Setting SOUNDCHECK_FAULTY_CRASH_ON_LOAD in the environment makes it
// crash as soon as its library is loaded instead, which is what a scan would
// hit (a Plugin's copy protection often runs that early).
//
// Its state is the Gain, as a 4-byte float. It has a window of its own, which
// draws nothing: it is only there so the helper's `editor` command has one to
// ask about.

#include "base/source/fstreamer.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "public.sdk/source/common/pluginview.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "public.sdk/source/vst/vstsinglecomponenteffect.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

enum : ParamID { kGain = 0, kCrash = 1, kHang = 2, kSlow = 3, kPoke = 4 };

class View : public CPluginView
{
public:
	View () : CPluginView (&size) {}
	tresult PLUGIN_API isPlatformTypeSupported (FIDString type) override
	{
		for (auto supported : {kPlatformTypeHWND, kPlatformTypeNSView, kPlatformTypeX11EmbedWindowID})
			if (std::strcmp (type, supported) == 0)
				return kResultTrue;
		return kResultFalse;
	}

private:
	static ViewRect size;
};
ViewRect View::size {0, 0, 420, 240};

class Faulty : public SingleComponentEffect
{
public:
	static FUnknown* create (void*) { return static_cast<IAudioProcessor*> (new Faulty); }

	tresult PLUGIN_API initialize (FUnknown* context) override
	{
		tresult result = SingleComponentEffect::initialize (context);
		if (result != kResultOk)
			return result;
		addAudioInput (STR16 ("In"), SpeakerArr::kStereo);
		addAudioOutput (STR16 ("Out"), SpeakerArr::kStereo);
		parameters.addParameter (STR16 ("Gain"), nullptr, 0, 1, ParameterInfo::kCanAutomate, kGain);
		parameters.addParameter (STR16 ("Crash"), nullptr, 1, 0, 0, kCrash);
		parameters.addParameter (STR16 ("Hang"), nullptr, 1, 0, 0, kHang);
		parameters.addParameter (STR16 ("Slow"), nullptr, 0, 0, 0, kSlow);
		parameters.addParameter (STR16 ("Poke"), nullptr, 1, 0, 0, kPoke);
		return kResultOk;
	}

	tresult PLUGIN_API setParamNormalized (ParamID id, ParamValue value) override
	{
		tresult result = SingleComponentEffect::setParamNormalized (id, value);
		if (id == kPoke && value > 0.5)
		{
			beginEdit (kGain);
			SingleComponentEffect::setParamNormalized (kGain, 0.25);
			performEdit (kGain, 0.25);
			endEdit (kGain);
		}
		return result;
	}

	tresult PLUGIN_API getParamStringByValue (ParamID id, ParamValue value, String128 text) override
	{
		if (id != kGain)
			return SingleComponentEffect::getParamStringByValue (id, value, text);
		char dB[32];
		if (value <= 0)
			std::snprintf (dB, sizeof (dB), "-inf dB");
		else
			std::snprintf (dB, sizeof (dB), "%.1f dB", 20 * std::log10 (value));
		UString (text, 128).fromAscii (dB);
		return kResultOk;
	}

	tresult PLUGIN_API setBusArrangements (SpeakerArrangement* inputs, int32 numIns,
	                                       SpeakerArrangement* outputs, int32 numOuts) override
	{
		if (numIns == 1 && numOuts == 1 && inputs[0] == SpeakerArr::kStereo &&
		    outputs[0] == SpeakerArr::kStereo)
			return kResultTrue;
		return kResultFalse;
	}

	tresult PLUGIN_API setProcessing (TBool) override { return kResultOk; }

	tresult PLUGIN_API process (ProcessData& data) override
	{
		if (auto* changes = data.inputParameterChanges)
		{
			for (int32 i = 0; i < changes->getParameterCount (); ++i)
			{
				auto* queue = changes->getParameterData (i);
				ParamValue value = 0;
				int32 offset = 0;
				if (!queue || queue->getPoint (queue->getPointCount () - 1, offset, value) != kResultOk)
					continue;
				switch (queue->getParameterId ())
				{
					case kGain: gain = static_cast<float> (value); break;
					case kCrash: if (value > 0.5) crash (); break;
					case kHang: if (value > 0.5) hang (); break;
					case kSlow: slow = value; break;
				}
			}
		}
		if (slow > 0)
			std::this_thread::sleep_for (std::chrono::duration<double> (slow / 10));
		if (data.numInputs < 1 || data.numOutputs < 1)
			return kResultOk;
		auto& in = data.inputs[0];
		auto& out = data.outputs[0];
		for (int32 c = 0; c < out.numChannels && c < in.numChannels; ++c)
			for (int32 i = 0; i < data.numSamples; ++i)
				out.channelBuffers32[c][i] = in.channelBuffers32[c][i] * gain;
		return kResultOk;
	}

	tresult PLUGIN_API getState (IBStream* state) override
	{
		IBStreamer streamer (state, kLittleEndian);
		return streamer.writeFloat (gain) ? kResultOk : kResultFalse;
	}

	tresult PLUGIN_API setState (IBStream* state) override
	{
		IBStreamer streamer (state, kLittleEndian);
		float value = 0;
		if (!streamer.readFloat (value))
			return kResultFalse;
		gain = value;
		setParamNormalized (kGain, value);
		return kResultOk;
	}

	IPlugView* PLUGIN_API createView (FIDString name) override
	{
		return std::strcmp (name, ViewType::kEditor) == 0 ? new View : nullptr;
	}

private:
	[[noreturn]] static void crash ()
	{
		volatile int* nowhere = nullptr;
		*nowhere = 1;
		std::abort ();
	}

	[[noreturn]] static void hang ()
	{
		while (true)
			std::this_thread::sleep_for (std::chrono::seconds (1));
	}

	float gain = 1;
	double slow = 0;
};

// Runs when the library is loaded, before anything is asked of it.
const bool crashOnLoad = [] {
	if (std::getenv ("SOUNDCHECK_FAULTY_CRASH_ON_LOAD"))
	{
		volatile int* nowhere = nullptr;
		*nowhere = 1;
	}
	return false;
}();

} // namespace

BEGIN_FACTORY_DEF ("Soundcheck", "https://github.com/adrianeyre/soundcheck", "")

DEF_CLASS2 (INLINE_UID (0x5C3A11E0, 0x6F1D4B2A, 0x9D2E7B41, 0x0F4C6A02), PClassInfo::kManyInstances,
            kVstAudioEffectClass, "Soundcheck Faulty", 0, "Fx", "1.0.0", kVstVersionString,
            Faulty::create)

END_FACTORY
