//! An ADSR amplitude envelope.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// Attack, decay and release are linear ramps; times are in seconds.
#[derive(Clone, Copy, Debug)]
pub struct Envelope {
    attack_step: f32,
    decay_step: f32,
    sustain: f32,
    release_seconds: f32,
    release_step: f32,
    sample_rate: f32,
    level: f32,
    stage: Stage,
}

impl Envelope {
    pub fn new(sample_rate: f32, attack: f32, decay: f32, sustain: f32, release: f32) -> Self {
        let step = |seconds: f32, distance: f32| distance / (seconds * sample_rate).max(1.0);
        let sustain = sustain.clamp(0.0, 1.0);
        Self {
            attack_step: step(attack, 1.0),
            decay_step: step(decay, 1.0 - sustain),
            sustain,
            release_seconds: release,
            release_step: 0.0,
            sample_rate,
            level: 0.0,
            stage: Stage::Idle,
        }
    }

    /// Change the shape without disturbing where the envelope has got to, so
    /// a setting can be turned while a note sounds.
    pub fn set_shape(&mut self, attack: f32, decay: f32, sustain: f32, release: f32) {
        let stage = self.stage;
        let level = self.level;
        let release_step = self.release_step;
        *self = Self::new(self.sample_rate, attack, decay, sustain, release);
        self.stage = stage;
        self.level = level;
        self.release_step = release_step;
    }

    /// Start (or restart, from the current level) the attack.
    pub fn trigger(&mut self) {
        self.stage = Stage::Attack;
    }

    /// Move to the release stage, however far the envelope has got.
    pub fn release(&mut self) {
        if self.stage != Stage::Idle {
            self.release_step = self.level / (self.release_seconds * self.sample_rate).max(1.0);
            self.stage = Stage::Release;
        }
    }

    /// Still producing sound.
    pub fn is_active(&self) -> bool {
        self.stage != Stage::Idle
    }

    /// Released, but maybe still fading out.
    pub fn is_released(&self) -> bool {
        matches!(self.stage, Stage::Release | Stage::Idle)
    }

    /// The level now, without moving on: what the last `next_level` returned,
    /// or 0 before the first.
    pub fn level(&self) -> f32 {
        self.level
    }

    /// The next level, in 0..=1.
    pub fn next_level(&mut self) -> f32 {
        match self.stage {
            Stage::Idle | Stage::Sustain => {}
            Stage::Attack => {
                self.level += self.attack_step;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.level -= self.decay_step;
                if self.level <= self.sustain {
                    self.level = self.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Release => {
                self.level -= self.release_step;
                if self.level <= 0.0 {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.level
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 1_000.0;

    fn run(envelope: &mut Envelope, samples: usize) -> f32 {
        (0..samples).fold(0.0, |_, _| envelope.next_level())
    }

    #[test]
    fn rises_decays_to_sustain_then_releases_to_silence() {
        let mut envelope = Envelope::new(RATE, 0.01, 0.1, 0.5, 0.2);
        assert!(!envelope.is_active());

        envelope.trigger();
        assert_eq!(run(&mut envelope, 10), 1.0, "peak after the attack");
        assert!((run(&mut envelope, 100) - 0.5).abs() < 1e-4, "sustain");

        envelope.release();
        assert!(envelope.is_active());
        run(&mut envelope, 200);
        assert_eq!(envelope.next_level(), 0.0);
        assert!(!envelope.is_active());
    }

    #[test]
    fn a_new_shape_keeps_the_level_and_changes_what_follows() {
        let mut envelope = Envelope::new(RATE, 0.01, 0.1, 0.5, 0.2);
        envelope.trigger();
        run(&mut envelope, 10);
        assert_eq!(envelope.level(), 1.0);

        // A longer decay to a higher sustain, from the level already reached.
        envelope.set_shape(0.01, 1.0, 0.8, 0.2);
        assert_eq!(envelope.level(), 1.0);
        assert!((run(&mut envelope, 1_000) - 0.8).abs() < 1e-4);
    }

    #[test]
    fn release_during_attack_fades_from_where_it_was() {
        let mut envelope = Envelope::new(RATE, 0.1, 0.1, 0.5, 0.1);
        envelope.trigger();
        let level = run(&mut envelope, 50);
        envelope.release();
        assert!(envelope.next_level() < level);
        run(&mut envelope, 100);
        assert!(!envelope.is_active());
    }
}
