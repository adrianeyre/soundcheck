//! The helper's control protocol, as `vst3-host/src/host.cpp` describes it: one
//! command per line on its stdin, fields separated by tabs, answered by data
//! lines and then one `ok` or `err` line on its protocol pipe.
//!
//! This is the slow path: loading, listing settings, state, the window. Audio
//! never goes through it; it goes through the shared memory (`shared.rs`).
//! ADR 0008 has the whole design.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

/// A helper's answer to one command.
#[derive(Debug, PartialEq, Eq)]
pub struct Reply {
    /// The data lines before the `ok`, each split into its fields.
    pub lines: Vec<Vec<String>>,
    /// The `ok` line's own fields, after `ok`.
    pub ok: Vec<String>,
}

/// Why a command got no `ok`.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// The helper answered `err`, and this is why.
    Refused(String),
    /// The helper's pipe closed: it has exited, or crashed.
    Gone,
    /// No answer in time: it is hung, or showing a dialog nobody can see.
    TimedOut,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Refused(why) => write!(f, "{why}"),
            Failure::Gone => write!(f, "the Plugin's process has stopped"),
            Failure::TimedOut => write!(f, "the Plugin's process didn't answer in time"),
        }
    }
}

/// One command line: fields joined by tabs. A field can't hold a tab or a
/// newline; paths and class ids never do.
pub fn command(fields: &[&str]) -> String {
    debug_assert!(fields.iter().all(|f| !f.contains(['\t', '\n'])));
    let mut line = fields.join("\t");
    line.push('\n');
    line
}

/// The fields of one line from the helper.
pub fn fields(line: &str) -> Vec<String> {
    line.trim_end_matches(['\r', '\n'])
        .split('\t')
        .map(str::to_string)
        .collect()
}

/// Bytes as the helper sends and takes them: lower-case hex.
pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 15)] as char);
    }
    out
}

/// The bytes `hex` spells, or `None` if it isn't hex.
pub fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// A helper's protocol pipe, read on a thread of its own so that a wait for
/// an answer can time out. A `notice` line is no answer: the helper sends
/// one whenever something happens in the Plugin's window, and it goes to
/// `on_notice`, its fields after `notice`. `on_close` runs on that thread
/// when the pipe closes, which is when the helper exits for any reason, a
/// crash included.
pub struct Lines {
    lines: Receiver<String>,
}

impl Lines {
    pub fn spawn(
        pipe: impl Read + Send + 'static,
        mut on_notice: impl FnMut(Vec<String>) + Send + 'static,
        on_close: impl FnOnce() + Send + 'static,
    ) -> Self {
        let (send, lines) = mpsc::channel();
        thread::Builder::new()
            .name("vst3-helper-pipe".into())
            .spawn(move || {
                for line in BufReader::new(pipe).lines() {
                    let Ok(line) = line else { break };
                    if line.starts_with("notice\t") {
                        on_notice(fields(&line).split_off(1));
                    } else if send.send(line).is_err() {
                        break;
                    }
                }
                on_close();
            })
            .expect("the pipe thread starts");
        Self { lines }
    }

    /// The answer to the command just sent, waiting at most `timeout` for
    /// each line of it.
    pub fn reply(&self, timeout: Duration) -> Result<Reply, Failure> {
        let mut lines = Vec::new();
        loop {
            let line = match self.lines.recv_timeout(timeout) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => return Err(Failure::TimedOut),
                Err(RecvTimeoutError::Disconnected) => return Err(Failure::Gone),
            };
            let mut parts = fields(&line);
            match parts.first().map(String::as_str) {
                Some("ok") => {
                    parts.remove(0);
                    return Ok(Reply { lines, ok: parts });
                }
                Some("err") => {
                    return Err(Failure::Refused(
                        parts.get(1..).unwrap_or_default().join(" "),
                    ));
                }
                _ => lines.push(parts),
            }
        }
    }
}

/// Sends one command.
pub fn send(to: &mut impl Write, fields: &[&str]) -> Result<(), Failure> {
    to.write_all(command(fields).as_bytes())
        .and_then(|()| to.flush())
        .map_err(|_| Failure::Gone)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_its_fields_joined_by_tabs() {
        assert_eq!(
            command(&["load", "/a b.vst3", "C18D"]),
            "load\t/a b.vst3\tC18D\n"
        );
    }

    #[test]
    fn hex_goes_there_and_back() {
        let bytes = [0u8, 1, 0x7f, 0x80, 0xff];
        assert_eq!(to_hex(&bytes), "00017f80ff");
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        assert_eq!(from_hex("").unwrap(), Vec::<u8>::new());
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn a_reply_is_its_data_lines_then_ok() {
        let text = "param\t0\tGain\t\t1.000000\t0\t1\nparam\t1\tCrash\t\t0.000000\t1\t0\nok\n";
        let lines = Lines::spawn(std::io::Cursor::new(text), |_| {}, || {});
        let reply = lines.reply(Duration::from_secs(1)).unwrap();
        assert_eq!(reply.lines.len(), 2);
        assert_eq!(reply.lines[0][2], "Gain");
        assert_eq!(reply.lines[1][2], "Crash");
        assert!(reply.ok.is_empty());
    }

    #[test]
    fn err_says_why() {
        let lines = Lines::spawn(
            std::io::Cursor::new("err\tno Plugin is loaded\n"),
            |_| {},
            || {},
        );
        assert_eq!(
            lines.reply(Duration::from_secs(1)),
            Err(Failure::Refused("no Plugin is loaded".into()))
        );
    }

    #[test]
    fn a_closed_pipe_means_the_helper_has_gone_and_says_so_once() {
        let (tell, told) = mpsc::channel();
        let lines = Lines::spawn(
            std::io::Cursor::new("class\tpartial"),
            |_| {},
            move || {
                tell.send(()).unwrap();
            },
        );
        assert_eq!(lines.reply(Duration::from_secs(1)), Err(Failure::Gone));
        told.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn a_notice_is_no_part_of_the_answer() {
        let (tell, told) = mpsc::channel();
        let text = "param\t0\tGain\nnotice\tedit\t0\t0.25\nok\n";
        let lines = Lines::spawn(
            std::io::Cursor::new(text),
            move |notice| tell.send(notice).unwrap(),
            || {},
        );
        let reply = lines.reply(Duration::from_secs(1)).unwrap();
        assert_eq!(reply.lines, [["param", "0", "Gain"]]);
        assert_eq!(told.recv().unwrap(), ["edit", "0", "0.25"]);
    }

    #[test]
    fn silence_times_out() {
        let (reader, _keep_open) = std::io::pipe().unwrap();
        let lines = Lines::spawn(reader, |_| {}, || {});
        assert_eq!(
            lines.reply(Duration::from_millis(20)),
            Err(Failure::TimedOut)
        );
    }
}
