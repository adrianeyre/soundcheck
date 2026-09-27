//! MIDI keyboards, read natively through midir. Notes go from midir's own
//! thread straight into the engine's MIDI queue, never through the webview.

use std::sync::{Arc, Mutex, PoisonError};

use midir::{Ignore, MidiInput, MidiInputConnection};
use rtrb::Producer;

use crate::command::RtCommand;

const NOTE_OFF: u8 = 0x80;
const NOTE_ON: u8 = 0x90;
const CLIENT: &str = "Soundcheck";

/// Read a note from a raw MIDI message, on any channel. Velocity is 0..=1.
/// The same rules as `parseMidiMessage` in `app/src/midi/midi-input.ts`.
pub fn parse_message(data: &[u8]) -> Option<RtCommand> {
    let (&status, rest) = data.split_first()?;
    let note = rest.first().copied().unwrap_or(0);
    let velocity = rest.get(1).copied().unwrap_or(0);
    match status & 0xf0 {
        // A note-on with velocity 0 is how many keyboards send note-off.
        NOTE_ON if velocity > 0 => Some(RtCommand::NoteOn {
            note,
            velocity: f32::from(velocity) / 127.0,
        }),
        NOTE_ON | NOTE_OFF => Some(RtCommand::NoteOff { note }),
        _ => None,
    }
}

/// Where MIDI notes go: the running engine's MIDI queue, or nowhere while no
/// audio is running. Locked on the MIDI thread, never on the audio thread.
type Sink = Arc<Mutex<Option<Producer<RtCommand>>>>;

/// Every connected MIDI keyboard.
#[derive(Default)]
pub struct Midi {
    sink: Sink,
    connections: Vec<(String, MidiInputConnection<()>)>,
}

impl Midi {
    /// Send notes to `queue` from now on, or drop them with `None`.
    pub fn route_to(&self, queue: Option<Producer<RtCommand>>) {
        *self.sink.lock().unwrap_or_else(PoisonError::into_inner) = queue;
    }

    /// Connect to keyboards that have appeared, forget ones that have gone,
    /// and return the names of those connected.
    pub fn refresh(&mut self) -> Result<Vec<String>, String> {
        let input = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
        let ports: Vec<_> = input
            .ports()
            .into_iter()
            .filter_map(|port| Some((input.port_name(&port).ok()?, port)))
            .collect();

        self.connections
            .retain(|(name, _)| ports.iter().any(|(port, _)| port == name));
        for (name, port) in ports {
            if self
                .connections
                .iter()
                .any(|(connected, _)| *connected == name)
            {
                continue;
            }
            // midir consumes the input on connecting, so each port gets its own.
            let mut input = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
            input.ignore(Ignore::All);
            let sink = Arc::clone(&self.sink);
            let connection = input.connect(
                &port,
                CLIENT,
                move |_, message, _| {
                    let Some(command) = parse_message(message) else {
                        return;
                    };
                    if let Some(queue) =
                        sink.lock().unwrap_or_else(PoisonError::into_inner).as_mut()
                    {
                        // A full queue drops the note rather than blocking.
                        let _ = queue.push(command);
                    }
                },
                (),
            );
            if let Ok(connection) = connection {
                self.connections.push((name, connection));
            }
        }
        Ok(self
            .connections
            .iter()
            .map(|(name, _)| name.clone())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn describe(data: &[u8]) -> Option<String> {
        parse_message(data).map(|command| match command {
            RtCommand::NoteOn { note, velocity } => format!("on {note} {velocity:.3}"),
            RtCommand::NoteOff { note } => format!("off {note}"),
            _ => "other".into(),
        })
    }

    #[test]
    fn notes_are_read_on_any_channel() {
        assert_eq!(describe(&[0x90, 60, 127]).as_deref(), Some("on 60 1.000"));
        assert_eq!(describe(&[0x9f, 61, 64]).as_deref(), Some("on 61 0.504"));
        assert_eq!(describe(&[0x80, 60, 0]).as_deref(), Some("off 60"));
        assert_eq!(
            describe(&[0x90, 60, 0]).as_deref(),
            Some("off 60"),
            "velocity 0"
        );
    }

    #[test]
    fn everything_else_is_ignored() {
        assert!(describe(&[0xb0, 7, 100]).is_none(), "a controller");
        assert!(describe(&[0xf8]).is_none(), "clock");
        assert!(describe(&[]).is_none());
    }
}
