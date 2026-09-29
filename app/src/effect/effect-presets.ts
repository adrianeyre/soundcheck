/**
 * The Effects' factory Presets: a named starting point for an Effect's
 * settings. Loading one copies all its settings into the Effect, where they
 * can then be changed.
 *
 * Every built-in Effect has a few, as a starting point the musician (or the
 * Assistant) tunes from. They live in the UI, not the engine, because
 * loading one is only a settings change, which the engine already takes.
 */
import { defaultEffectSettings, type EffectSettingsByType, type EffectType } from "./effect-params";

export interface EffectPreset<T extends EffectType = EffectType> {
  name: string;
  /** What it sounds like, for the musician and the Assistant. */
  description: string;
  settings: EffectSettingsByType[T];
}

/** Every factory Preset of each Effect, in the order the picker lists them. */
export const EFFECT_PRESETS: { readonly [T in EffectType]: readonly EffectPreset<T>[] } = {
  eq: [
    {
      name: "Vocal presence",
      description: "Cuts the rumble and mud under a voice and lifts its presence and air",
      settings: {
        ...defaultEffectSettings("eq"),
        lowCut: "on",
        lowCutHz: 90,
        band1Hz: 300,
        band1Q: 1.2,
        band1GainDb: -3,
        band3Hz: 4000,
        band3Q: 1,
        band3GainDb: 3,
        highShelfHz: 10000,
        highShelfGainDb: 2.5,
      },
    },
    {
      name: "Low-end cleanup",
      description: "Takes out the sub rumble and boxiness so a part sits clear of the kick and bass",
      settings: { ...defaultEffectSettings("eq"), lowCut: "on", lowCutHz: 120, band1Hz: 400, band1Q: 1.5, band1GainDb: -4 },
    },
    {
      name: "Kick punch",
      description: "Deepens a kick's thump, scoops its boxiness and brings out the beater's click",
      settings: {
        ...defaultEffectSettings("eq"),
        lowShelfHz: 60,
        lowShelfGainDb: 4,
        band1Hz: 350,
        band1Q: 1.4,
        band1GainDb: -5,
        band3Hz: 3500,
        band3Q: 1.2,
        band3GainDb: 4,
      },
    },
    {
      name: "Telephone",
      description: "Squeezes the sound into a narrow, lo-fi band, as through an old phone",
      settings: {
        ...defaultEffectSettings("eq"),
        lowCut: "on",
        lowCutHz: 400,
        band2Hz: 1500,
        band2Q: 1,
        band2GainDb: 6,
        highCut: "on",
        highCutHz: 3500,
      },
    },
  ],
  compressor: [
    {
      name: "Gentle glue",
      description: "A light, slow squeeze that holds a mix or a Bus together without pumping",
      settings: { thresholdDb: -20, ratio: 2, attack: 30, release: 300, makeupDb: 2, kneeDb: 12 },
    },
    {
      name: "Vocal leveller",
      description: "Evens out a vocal's loud and quiet words so it stays in front",
      settings: { thresholdDb: -24, ratio: 4, attack: 5, release: 120, makeupDb: 6, kneeDb: 6 },
    },
    {
      name: "Drum smash",
      description: "Hard, fast compression for big, aggressive drums; blend it on a Bus",
      settings: { thresholdDb: -30, ratio: 12, attack: 1, release: 60, makeupDb: 10, kneeDb: 0 },
    },
    {
      name: "Bass control",
      description: "Holds a bass line at one steady level, note after note",
      settings: { thresholdDb: -22, ratio: 5, attack: 10, release: 150, makeupDb: 5, kneeDb: 4 },
    },
  ],
  reverb: [
    {
      name: "Small room",
      description: "A short, natural room that puts a sound in a space without washing it out",
      settings: { size: 0.3, decay: 0.6, damping: 0.6, preDelay: 5, width: 0.8, mix: 0.2 },
    },
    {
      name: "Large hall",
      description: "A long, wide concert-hall tail for pads, strings and ballads",
      settings: { size: 0.9, decay: 4.5, damping: 0.4, preDelay: 30, width: 1, mix: 0.3 },
    },
    {
      name: "Plate",
      description: "A bright, dense plate, the classic sheen on vocals and snares",
      settings: { size: 0.6, decay: 2, damping: 0.2, preDelay: 15, width: 1, mix: 0.25 },
    },
    {
      name: "Ambient wash",
      description: "An endless, dark tail to send a part into the distance; fully wet on a Bus",
      settings: { size: 1, decay: 9, damping: 0.7, preDelay: 60, width: 1, mix: 1 },
    },
  ],
  delay: [
    {
      name: "Slapback",
      description: "One quick, bright echo, as on a rockabilly vocal",
      settings: { ...defaultEffectSettings("delay"), sync: "off", timeMs: 110, feedback: 0.1, highCutHz: 6000, mix: 0.3 },
    },
    {
      name: "Quarter echo",
      description: "Repeats a quarter note apart, in time with the song, fading away",
      settings: { ...defaultEffectSettings("delay"), sync: "on", note: "1/4", feedback: 0.35, highCutHz: 8000, mix: 0.3 },
    },
    {
      name: "Dotted-eighth ping-pong",
      description: "Repeats a dotted eighth apart, bouncing between left and right",
      settings: {
        ...defaultEffectSettings("delay"),
        sync: "on",
        note: "1/8 dotted",
        feedback: 0.45,
        highCutHz: 5000,
        pingPong: "on",
        mix: 0.35,
      },
    },
  ],
  saturator: [
    {
      name: "Tape warmth",
      description: "A gentle, tape-like thickening that rounds off harsh edges",
      settings: { driveDb: 6, shape: "soft", toneHz: 9000, outputDb: -2, mix: 1 },
    },
    {
      name: "Tube drive",
      description: "A lopsided valve crunch that adds warm even harmonics",
      settings: { driveDb: 14, shape: "tube", toneHz: 7000, outputDb: -6, mix: 0.8 },
    },
    {
      name: "Hard clip",
      description: "Squares off the peaks for loud, gritty drums and bass",
      settings: { driveDb: 18, shape: "hard", toneHz: 12000, outputDb: -8, mix: 1 },
    },
    {
      name: "Wavefold",
      description: "Folds the peaks back on themselves for metallic, synthy overtones",
      settings: { driveDb: 20, shape: "fold", toneHz: 14000, outputDb: -6, mix: 0.6 },
    },
  ],
  chorus: [
    {
      name: "Classic chorus",
      description: "A lush, slow, wide doubling, as on an 80s clean guitar",
      settings: { rateHz: 0.8, depthMs: 3, delayMs: 12, feedback: 0, width: 1, mix: 0.5 },
    },
    {
      name: "Wide doubler",
      description: "A subtle second voice that widens a part without an obvious wobble",
      settings: { rateHz: 0.3, depthMs: 1.5, delayMs: 20, feedback: 0, width: 1, mix: 0.4 },
    },
    {
      name: "Flanger",
      description: "A short, fed-back sweep for the jet-plane whoosh",
      settings: { rateHz: 0.25, depthMs: 2.5, delayMs: 1.5, feedback: 0.7, width: 0.5, mix: 0.5 },
    },
  ],
  phaser: [
    {
      name: "Slow swirl",
      description: "A slow, deep sweep for pads and electric pianos",
      settings: { rateHz: 0.2, depth: 0.8, centreHz: 700, feedback: 0.4, stages: "4", mix: 0.5 },
    },
    {
      name: "Funky phase",
      description: "A quicker, resonant sweep for clean guitar and clav",
      settings: { rateHz: 1.5, depth: 0.6, centreHz: 1200, feedback: 0.7, stages: "6", mix: 0.5 },
    },
    {
      name: "Deep jet",
      description: "Twelve stages and heavy feedback for a dramatic, vocal sweep",
      settings: { rateHz: 0.1, depth: 1, centreHz: 900, feedback: 0.85, stages: "12", mix: 0.5 },
    },
  ],
  filter: [
    {
      name: "Low-pass sweep",
      description: "A slowly opening and closing low-pass for build-ups and breakdowns",
      settings: { mode: "low-pass", cutoffHz: 1200, resonance: 4, lfoRateHz: 0.1, lfoDepth: 2.5, driveDb: 3, mix: 1 },
    },
    {
      name: "Wobble",
      description: "A fast, resonant low-pass wobble, as on a dubstep bass",
      settings: { mode: "low-pass", cutoffHz: 600, resonance: 8, lfoRateHz: 4, lfoDepth: 2, driveDb: 6, mix: 1 },
    },
    {
      name: "Thin out",
      description: "A static high-pass that takes a part's weight away, for an intro or a breakdown",
      settings: { mode: "high-pass", cutoffHz: 800, resonance: 1, lfoRateHz: 1, lfoDepth: 0, driveDb: 0, mix: 1 },
    },
    {
      name: "Radio",
      description: "A narrow band-pass for a tinny, far-away sound",
      settings: { mode: "band-pass", cutoffHz: 1500, resonance: 2, lfoRateHz: 1, lfoDepth: 0, driveDb: 6, mix: 1 },
    },
  ],
  gate: [
    {
      name: "Tight drums",
      description: "Shuts off the ring and spill between hits",
      settings: { thresholdDb: -30, rangeDb: -80, attack: 0.5, hold: 30, release: 80 },
    },
    {
      name: "Noise cleanup",
      description: "Softly turns down hiss and hum in the gaps of a recording",
      settings: { thresholdDb: -50, rangeDb: -20, attack: 2, hold: 50, release: 250 },
    },
    {
      name: "Chop",
      description: "A hard, fast gate for choppy, stuttering effects",
      settings: { thresholdDb: -20, rangeDb: -80, attack: 0.1, hold: 0, release: 10 },
    },
  ],
  limiter: [
    {
      name: "Master ceiling",
      description: "Catches the peaks at -1 dB so the mix never clips, with nothing else changed",
      settings: { inputGainDb: 0, ceilingDb: -1, release: 80, lookahead: 5 },
    },
    {
      name: "Loud master",
      description: "Pushes the mix up for a loud, finished master",
      settings: { inputGainDb: 6, ceilingDb: -0.3, release: 60, lookahead: 5 },
    },
    {
      name: "Brickwall",
      description: "An instant, hard ceiling for stems and bounces",
      settings: { inputGainDb: 0, ceilingDb: -0.1, release: 20, lookahead: 10 },
    },
  ],
  bitcrusher: [
    {
      name: "8-bit console",
      description: "The crunchy, aliased sound of an old games console",
      settings: { bits: 8, downsample: 4, mix: 1 },
    },
    {
      name: "Lo-fi grit",
      description: "A little noise and grit blended under the clean sound",
      settings: { bits: 10, downsample: 2, mix: 0.4 },
    },
    {
      name: "Destroyed",
      description: "Four bits, heavily downsampled: barely recognisable",
      settings: { bits: 4, downsample: 16, mix: 1 },
    },
  ],
  utility: [
    {
      name: "Mono check",
      description: "Sums the channel to mono, to hear how the mix holds up on one speaker",
      settings: { ...defaultEffectSettings("utility"), mono: "on" },
    },
    {
      name: "Extra wide",
      description: "Widens the stereo image by half again",
      settings: { ...defaultEffectSettings("utility"), width: 1.5 },
    },
    {
      name: "Flip polarity",
      description: "Inverts both sides, to fix a recording that cancels against another",
      settings: { ...defaultEffectSettings("utility"), invertLeft: "on", invertRight: "on" },
    },
  ],
  flanger: [
    {
      name: "Jet sweep",
      description: "A slow, deep whoosh with a strong ring, like a jet passing overhead",
      settings: { rateHz: 0.15, delayMs: 0.5, depthMs: 5, feedback: 0.8, stereoPhase: 90, mix: 0.5 },
    },
    {
      name: "Metallic",
      description: "Negative feedback on a short, quick sweep, for a hollow, tinny ring",
      settings: { rateHz: 0.8, delayMs: 0.3, depthMs: 1.5, feedback: -0.7, stereoPhase: 180, mix: 0.5 },
    },
    {
      name: "Gentle movement",
      description: "A soft, subtle sweep that adds motion to pads and guitars without a ring",
      settings: { rateHz: 0.25, delayMs: 2, depthMs: 2, feedback: 0.2, stereoPhase: 90, mix: 0.35 },
    },
  ],
  tremolo: [
    {
      name: "Vintage amp",
      description: "A smooth, steady throb, like the tremolo on an old guitar amp",
      settings: { sync: "off", note: "1/8", rateHz: 5.5, shape: "sine", depth: 0.5, stereoPhase: 0 },
    },
    {
      name: "Sixteenth chop",
      description: "A square gate in sixteenth notes that chops a pad or chord in time with the song",
      settings: { sync: "on", note: "1/16", rateHz: 5, shape: "square", depth: 1, stereoPhase: 0 },
    },
    {
      name: "Stereo shimmer",
      description: "The sides pulse against each other in eighth notes, so the sound throbs from side to side",
      settings: { sync: "on", note: "1/8", rateHz: 5, shape: "triangle", depth: 0.7, stereoPhase: 180 },
    },
  ],
  autopan: [
    {
      name: "Slow drift",
      description: "A gentle, slow sweep that lets a pad or texture wander across the stereo image",
      settings: { sync: "off", note: "1/4", rateHz: 0.2, shape: "sine", depth: 0.6 },
    },
    {
      name: "Bar sweep",
      description: "One full sweep left and right per bar, in time with the song",
      settings: { sync: "on", note: "1/1", rateHz: 0.5, shape: "triangle", depth: 1 },
    },
    {
      name: "Ping-pong eighths",
      description: "Jumps hard left and right on eighth notes, for a bouncing, rhythmic part",
      settings: { sync: "on", note: "1/4", rateHz: 0.5, shape: "square", depth: 1 },
    },
  ],
  ringmod: [
    {
      name: "Robot voice",
      description: "A low, steady carrier that turns a voice metallic and robotic",
      settings: { frequencyHz: 60, driftRateHz: 0.5, driftDepth: 0, mix: 1 },
    },
    {
      name: "Bell tones",
      description: "A high carrier blended with the dry signal, for inharmonic, bell-like overtones",
      settings: { frequencyHz: 1200, driftRateHz: 0.5, driftDepth: 0, mix: 0.5 },
    },
    {
      name: "Sci-fi drift",
      description: "A carrier that slowly bends up and down, so the ring sighs and swoops",
      settings: { frequencyHz: 400, driftRateHz: 0.3, driftDepth: 7, mix: 0.8 },
    },
  ],
  vibrato: [
    {
      name: "Singer",
      description: "A natural, gentle waver, like a held note from a singer or a violin",
      settings: { rateHz: 5.5, depthCents: 25, stereoPhase: 0 },
    },
    {
      name: "Warped tape",
      description: "A slow, deep wobble, like a worn cassette or a warped record",
      settings: { rateHz: 0.8, depthCents: 40, stereoPhase: 0 },
    },
    {
      name: "Wide swim",
      description: "The sides bend opposite ways, which widens the sound and makes it swim",
      settings: { rateHz: 3, depthCents: 15, stereoPhase: 180 },
    },
  ],
  transient: [
    {
      name: "Punchy Kick",
      description: "Sharpens the click of each hit and trims the boom after it.",
      settings: { attack: 60, sustain: -30, outputDb: 0, mix: 1 },
    },
    {
      name: "Tight Drums",
      description: "Cuts the ring and room from a drum loop so it sits tight in the groove.",
      settings: { attack: 20, sustain: -70, outputDb: 1, mix: 1 },
    },
    {
      name: "Soft Pluck",
      description: "Rounds off a sharp pluck's start and lets its tail bloom.",
      settings: { attack: -50, sustain: 40, outputDb: 0, mix: 0.8 },
    },
  ],
  deesser: [
    {
      name: "Gentle Vocal",
      description: "Takes the edge off a singer's s sounds without dulling the voice.",
      settings: { frequencyHz: 6500, thresholdDb: -24, rangeDb: 6, listen: "off" },
    },
    {
      name: "Harsh Esses",
      description: "Clamps down hard on bright, spitty sibilance.",
      settings: { frequencyHz: 7500, thresholdDb: -32, rangeDb: 14, listen: "off" },
    },
    {
      name: "Cymbal Tamer",
      description: "Calms splashy cymbals and hats that jump out of a drum bus.",
      settings: { frequencyHz: 10000, thresholdDb: -28, rangeDb: 8, listen: "off" },
    },
  ],
  exciter: [
    {
      name: "Vocal Air",
      description: "Adds a breathy shine above the voice without making it harsh.",
      settings: { frequencyHz: 8000, driveDb: 9, amount: 0.25, mix: 1 },
    },
    {
      name: "Bright Lead",
      description: "Gives a dull synth lead new top end so it cuts through the mix.",
      settings: { frequencyHz: 3000, driveDb: 15, amount: 0.4, mix: 1 },
    },
    {
      name: "Hat Sizzle",
      description: "Pushes hi-hats and shakers for extra sizzle at the very top.",
      settings: { frequencyHz: 10000, driveDb: 18, amount: 0.35, mix: 0.8 },
    },
  ],
  multiband: [
    {
      name: "Master Glue",
      description: "Gentle control across all three bands to hold a full mix together.",
      settings: {
        lowCrossoverHz: 150,
        highCrossoverHz: 4000,
        lowThresholdDb: -18,
        lowRatio: 2,
        midThresholdDb: -20,
        midRatio: 1.5,
        highThresholdDb: -22,
        highRatio: 2,
        attack: 20,
        release: 200,
        outputDb: 2,
      },
    },
    {
      name: "Tame the Bass",
      description: "Holds a boomy low end steady while the mids and highs pass as they are.",
      settings: {
        lowCrossoverHz: 120,
        highCrossoverHz: 3000,
        lowThresholdDb: -28,
        lowRatio: 6,
        midThresholdDb: 0,
        midRatio: 1,
        highThresholdDb: 0,
        highRatio: 1,
        attack: 15,
        release: 150,
        outputDb: 1,
      },
    },
    {
      name: "Smooth Top",
      description: "Rides down harsh highs and sibilance on a bright bus.",
      settings: {
        lowCrossoverHz: 200,
        highCrossoverHz: 5000,
        lowThresholdDb: 0,
        lowRatio: 1,
        midThresholdDb: -24,
        midRatio: 1.5,
        highThresholdDb: -30,
        highRatio: 4,
        attack: 2,
        release: 80,
        outputDb: 0,
      },
    },
  ],
  clipper: [
    {
      name: "Hard Trance Kick",
      description: "Drives the kick hard into a flat ceiling for a loud, cutting thump.",
      settings: { inputDb: 9, ceilingDb: -1, softness: 0, outputDb: 0, mix: 1 },
    },
    {
      name: "Soft Peak Shave",
      description: "Rounds off the loudest peaks of a bus for a few dB more level, barely heard.",
      settings: { inputDb: 3, ceilingDb: -0.5, softness: 0.6, outputDb: 0, mix: 1 },
    },
    {
      name: "Parallel Grit",
      description: "Crushes a copy of the drums and blends it under the clean ones.",
      settings: { inputDb: 18, ceilingDb: -6, softness: 0.2, outputDb: 3, mix: 0.35 },
    },
  ],
  freqshift: [
    {
      name: "Slow swirl",
      description: "A shift of a couple of hertz, blended with the dry signal, for a slow phaser-like swirl",
      settings: { shiftHz: 2, feedback: 0, mix: 0.5 },
    },
    {
      name: "Metallic clang",
      description: "Pulls the harmonics apart into an inharmonic, bell-like and metallic tone",
      settings: { shiftHz: 330, feedback: 0.2, mix: 1 },
    },
    {
      name: "Falling spiral",
      description: "A small downward shift fed back on itself, so the sound seems to fall endlessly",
      settings: { shiftHz: -25, feedback: 0.7, mix: 0.6 },
    },
  ],
  autowah: [
    {
      name: "Funk guitar",
      description: "A quick, vocal band-pass wah that opens on every strum",
      settings: {
        mode: "band-pass",
        lowHz: 350,
        highHz: 2200,
        sensitivityDb: 12,
        attackMs: 3,
        releaseMs: 120,
        resonance: 5,
        mix: 1,
      },
    },
    {
      name: "Squelchy bass",
      description: "A resonant low-pass that snaps open on each bass note and closes slowly",
      settings: {
        mode: "low-pass",
        lowHz: 120,
        highHz: 1800,
        sensitivityDb: 18,
        attackMs: 2,
        releaseMs: 250,
        resonance: 8,
        mix: 1,
      },
    },
    {
      name: "Gentle quack",
      description: "A wide, soft wah blended with the dry signal, for a subtle movement on keys",
      settings: {
        mode: "band-pass",
        lowHz: 400,
        highHz: 1600,
        sensitivityDb: 6,
        attackMs: 15,
        releaseMs: 300,
        resonance: 2,
        mix: 0.6,
      },
    },
  ],
  haas: [
    {
      name: "Subtle width",
      description: "A few milliseconds on one side, for a little width that still sums well to mono",
      settings: { side: "right", delayMs: 8, levelDb: -3, mix: 1 },
    },
    {
      name: "Wide double",
      description: "A long delay at nearly full level, which spreads a mono part right across the image",
      settings: { side: "right", delayMs: 25, levelDb: -1, mix: 1 },
    },
    {
      name: "Lean left",
      description: "Delays the left side, so the part sits wide and towards the right",
      settings: { side: "left", delayMs: 15, levelDb: -2, mix: 1 },
    },
  ],
  resonator: [
    {
      name: "Tuned drums",
      description: "Rings a drum loop at C, so the hits sing a low note under the groove",
      settings: {
        tuneBy: "note",
        note: "C",
        octave: 2,
        frequencyHz: 220,
        chord: "octave",
        decay: 0.6,
        brightness: 0.4,
        mix: 0.4,
      },
    },
    {
      name: "Minor chord pad",
      description: "Turns noise or a voice into a long, ringing A minor chord",
      settings: {
        tuneBy: "note",
        note: "A",
        octave: 3,
        frequencyHz: 220,
        chord: "minor",
        decay: 4,
        brightness: 0.6,
        mix: 0.7,
      },
    },
    {
      name: "Metal bar",
      description: "A bright, high, long-ringing tone, like a struck metal bar",
      settings: {
        tuneBy: "frequency",
        note: "C",
        octave: 3,
        frequencyHz: 880,
        chord: "unison",
        decay: 2.5,
        brightness: 1,
        mix: 0.5,
      },
    },
  ],
  vowel: [
    {
      name: "Talking lead",
      description: "Swings between A and I at an easy pace, so a synth lead says \"yah-yee\"",
      settings: { vowel: "E", morph: 0, resonance: 8, lfoRateHz: 1.5, lfoDepth: 1, mix: 1 },
    },
    {
      name: "Wobble bass",
      description: "A fast, deep sweep through the vowels, for a talking, wobbling bass",
      settings: { vowel: "O", morph: 0.5, resonance: 10, lfoRateHz: 4, lfoDepth: 1.5, mix: 1 },
    },
    {
      name: "Choir ooh",
      description: "A still, soft O-U vowel blended with the dry signal, for a pad that sounds sung",
      settings: { vowel: "O", morph: 0.5, resonance: 5, lfoRateHz: 0.2, lfoDepth: 0.1, mix: 0.6 },
    },
  ],
  pump: [
    {
      name: "Hard trance pump",
      description: "Deep quarter-note ducking that stays down and snaps back late, for rolling basslines and supersaws",
      settings: { note: "1/4", depth: 0.9, release: 0.8, curve: 0.2, phase: 0, mix: 1 },
    },
    {
      name: "Gentle breathing",
      description: "A light, quick sidechain feel that glues pads to the kick without drawing attention",
      settings: { note: "1/4", depth: 0.4, release: 0.5, curve: 0.7, phase: 0, mix: 1 },
    },
    {
      name: "Eighth-note chop",
      description: "Short dips twice a beat, a fast pumping groove for plucks and off-beat bass",
      settings: { note: "1/8", depth: 0.8, release: 0.6, curve: 0.4, phase: 0, mix: 1 },
    },
  ],
  trancegate: [
    {
      name: "Classic gate",
      description: "Tight sixteenth-note chops on every step, the stuttering supersaw pad of trance",
      settings: { step: "1/16", pattern: "sixteenths", attackMs: 1, releaseMs: 15, depth: 1, mix: 1 },
    },
    {
      name: "Gallop",
      description: "A driving one-and-two gallop rhythm for leads and hard-trance stabs",
      settings: { step: "1/16", pattern: "gallop", attackMs: 1, releaseMs: 10, depth: 1, mix: 1 },
    },
    {
      name: "Soft tresillo",
      description: "A smoother three-three-two pulse that leaves some of the pad between the steps",
      settings: { step: "1/16", pattern: "tresillo", attackMs: 8, releaseMs: 60, depth: 0.7, mix: 1 },
    },
  ],
  pitchshift: [
    {
      name: "Octave up",
      description: "An octave above blended under the original, for a brighter, bigger lead",
      settings: { semitones: 12, cents: 0, grainMs: 50, mix: 0.4 },
    },
    {
      name: "Sub octave",
      description: "An octave below with long grains, to thicken a bass or a lead from underneath",
      settings: { semitones: -12, cents: 0, grainMs: 100, mix: 0.4 },
    },
    {
      name: "Fifth harmony",
      description: "A fifth above, slightly detuned, for an instant power-chord harmony",
      settings: { semitones: 7, cents: 5, grainMs: 60, mix: 0.35 },
    },
  ],
  lofi: [
    {
      name: "Worn cassette",
      description: "A tape that has been played to death: wobbly, dark and hissy",
      settings: { wow: 0.6, flutter: 0.4, toneHz: 4000, drive: 0.4, hiss: 0.4, mix: 1 },
    },
    {
      name: "Warm tape",
      description: "Just a touch of tape: gentle saturation and a softened top, barely any wobble",
      settings: { wow: 0.1, flutter: 0.1, toneHz: 12000, drive: 0.5, hiss: 0.05, mix: 1 },
    },
    {
      name: "Lo-fi beat",
      description: "A dusty, muffled sound for chilled keys and drums",
      settings: { wow: 0.4, flutter: 0.2, toneHz: 2500, drive: 0.3, hiss: 0.3, mix: 0.8 },
    },
  ],
  beatrepeat: [
    {
      name: "Sixteenth stutter",
      description: "A machine-gun sixteenth roll for the end of a build; automate Repeat to fire it",
      settings: { slice: "1/16", repeat: 0, decay: 0, mix: 1 },
    },
    {
      name: "Fading eighths",
      description: "Eighth-note repeats that die away, like a quick echo of the last beat",
      settings: { slice: "1/8", repeat: 0, decay: 0.3, mix: 1 },
    },
    {
      name: "Thirty-second buzz",
      description: "Very short repeats that turn a hit into a buzzing, pitched roll",
      settings: { slice: "1/32", repeat: 0, decay: 0, mix: 1 },
    },
  ],
};

/** The factory Presets of `type`, looked at without their settings' type. */
export function effectPresets(type: EffectType): readonly EffectPreset[] {
  return EFFECT_PRESETS[type] as readonly EffectPreset[];
}

/** The factory Preset of `type` called `name`, or undefined if it has none. */
export function effectPreset(type: EffectType, name: string): EffectPreset | undefined {
  return effectPresets(type).find((preset) => preset.name === name);
}
