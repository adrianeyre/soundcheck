/**
 * One `EngineCommand`, carried out on a WASM Engine. The AudioWorklet does
 * this for the engine it plays, and the browser's Audio Analysis for the
 * engine it renders offline, so both hear the same thing.
 */
import type { Engine } from "@engine";

import type { WasmPluginHost } from "../plugin/wasm-plugin-runtime";
import type { EngineCommand } from "./audio-output";

/**
 * `plugins` runs the engine's WASM Plugins; without one, every Plugin Effect
 * is held as a missing Plugin and passes audio through, and every Plugin
 * Instrument as a missing one, which is silent.
 */
export function applyEngineCommand(engine: Engine, command: EngineCommand, plugins?: WasmPluginHost): void {
  switch (command.type) {
    case "noteOn":
      return engine.note_on(command.note, command.velocity);
    case "noteOff":
      return engine.note_off(command.note);
    case "setTrackCount":
      return engine.set_track_count(command.count);
    case "setTrackNotes":
      return engine.set_track_notes(command.track, new Float64Array(command.notes));
    case "setTrackMixer":
      return engine.set_track_mixer(
        command.track,
        command.volume,
        command.pan,
        command.mute,
        command.solo,
      );
    case "setMasterVolume":
      return engine.set_master_volume(command.volume);
    case "setBusCount":
      return engine.set_bus_count(command.count);
    case "setBusMixer":
      return engine.set_bus_mixer(command.bus, command.volume, command.pan, command.mute, command.solo);
    case "setTrackOutput":
      engine.set_track_output(command.track, command.output);
      return;
    case "setBusOutput":
      // The UI refuses a loop before sending one; the engine refuses it too.
      engine.set_bus_output(command.bus, command.output);
      return;
    case "setSends":
      engine.set_sends(command.channel, new Float64Array(command.sends));
      return;
    case "insertEffect":
      engine.insert_effect(command.chain, command.index, command.effect);
      return;
    case "loadPlugin":
      return plugins?.load(command.plugin, command.wasm);
    case "insertPlugin":
      if (plugins) plugins.insert(engine, command.chain, command.index, command.plugin);
      else engine.insert_missing_plugin(command.chain, command.index, command.plugin);
      return;
    case "setTrackPlugin":
      if (plugins) plugins.setInstrument(engine, command.track, command.plugin);
      else engine.set_track_missing_instrument(command.track, command.plugin);
      return;
    // The browser hosts no VST3 Plugin: each is missing (ADR 0008).
    case "insertVst3":
      engine.insert_missing_plugin(command.chain, command.index, `vst3:${command.instance}`);
      return;
    case "setTrackVst3":
      engine.set_track_missing_instrument(command.track, `vst3:${command.instance}`);
      return;
    case "setInstrumentSettings":
      return engine.set_track_instrument_settings(command.track, new Float32Array(command.settings));
    case "removeEffect":
      return engine.remove_effect(command.chain, command.index);
    case "moveEffect":
      return engine.move_effect(command.chain, command.from, command.to);
    case "setEffectBypassed":
      return engine.set_effect_bypassed(command.chain, command.index, command.bypassed);
    case "setEffectSettings":
      return engine.set_effect_settings(command.chain, command.index, new Float32Array(command.settings));
    case "setSynthSettings":
      return engine.set_track_synth(command.track, new Float32Array(command.settings));
    case "setTrackInstrument":
      engine.set_track_instrument(command.track, command.instrument, command.pads ?? undefined);
      return;
    case "setPad":
      return engine.set_track_pad(
        command.track,
        command.pad,
        command.note,
        command.volume,
        command.pan,
        command.pitch,
        command.chokeGroup,
      );
    case "setPadSample":
      // What is wrong with the file, if anything, is the UI's to report:
      // it checked before sending.
      engine.load_track_pad_sample(command.track, command.pad, new Uint8Array(command.wav));
      return;
    case "clearPadSample":
      return engine.clear_track_pad_sample(command.track, command.pad);
    case "setTrackAudio":
      return engine.set_track_audio(command.track, command.audio);
    case "setTrackMonitoring":
      return engine.set_track_monitoring(command.track, command.on);
    case "loadAudioFile":
      // What is wrong with the file, if anything, is the UI's to report:
      // it checked before sending.
      engine.load_audio_file(command.file, new Uint8Array(command.bytes));
      return;
    case "unloadAudioFile":
      return engine.unload_audio_file(command.file);
    case "setTrackAudioClips":
      return engine.set_track_audio_clips(command.track, new Float64Array(command.clips));
    case "setPatternPlaying":
      return engine.set_pattern_playing(command.playing);
    case "setLatencyTest":
      return engine.set_latency_test(command.on);
    case "setLiveTrack":
      return engine.set_live_track(command.track ?? undefined);
    case "setRecording":
      return engine.set_recording(command.on);
    case "play":
      return engine.play();
    case "stop":
      return engine.stop();
    case "seek":
      return engine.seek(command.tick);
    case "setTempo":
      return engine.set_tempo(command.bpm);
    case "setTimeSignature":
      return engine.set_time_signature(command.beatsPerBar, command.beatUnit);
    case "setTempoChanges":
      return engine.set_tempo_changes(new Float64Array(command.changes));
    case "setAutomation":
      return engine.set_automation(command.target, command.setting, new Float64Array(command.points));
    case "setLoop":
      return engine.set_loop(command.startTick, command.endTick, command.enabled);
    case "setMetronome":
      return engine.set_metronome(command.on);
  }
}
