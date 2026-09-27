//! A Project on disk: one folder holding `project.json` and an `audio/`
//! folder with a copy of every audio file the Project uses (#16).
//!
//! The UI names files by a path relative to the Project folder, always with
//! "/" separators, so a folder opens the same after being moved, copied or
//! carried to another machine. Every path is resolved here and refused if it
//! could lead out of the folder, so a damaged or hostile `project.json`
//! can't reach the rest of the disk.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Join a folder-relative path onto its folder, refusing anything that isn't
/// a plain relative path inside it.
pub fn resolve(folder: &str, path: &str) -> Result<PathBuf, String> {
    let refuse = || Err(format!("{path} is not a path inside the folder"));
    // A backslash separates folders on Windows and is a filename character
    // everywhere else; refusing it keeps every platform reading a Project
    // folder the same way.
    if path.contains('\\') {
        return refuse();
    }
    let mut resolved = PathBuf::from(folder);
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            _ => return refuse(),
        }
    }
    Ok(resolved)
}

pub fn read_text(folder: &str, path: &str) -> Result<String, String> {
    let file = resolve(folder, path)?;
    fs::read_to_string(&file)
        .map_err(|error| format!("{} could not be read: {error}", file.display()))
}

/// Write a text file, making the folders it needs.
pub fn write_text(folder: &str, path: &str, text: &str) -> Result<(), String> {
    let file = resolve(folder, path)?;
    make_parent(&file)?;
    fs::write(&file, text)
        .map_err(|error| format!("{} could not be written: {error}", file.display()))
}

/// Read a file as the bytes it holds, for the audio a Project folder keeps.
pub fn read_bytes(folder: &str, path: &str) -> Result<Vec<u8>, String> {
    let file = resolve(folder, path)?;
    fs::read(&file).map_err(|error| format!("{} could not be read: {error}", file.display()))
}

/// Write a file of bytes, making the folders it needs.
pub fn write_bytes(folder: &str, path: &str, bytes: &[u8]) -> Result<(), String> {
    let file = resolve(folder, path)?;
    make_parent(&file)?;
    fs::write(&file, bytes)
        .map_err(|error| format!("{} could not be written: {error}", file.display()))
}

/// Add text to the end of a file, making it and the folders it needs if it
/// isn't there yet: how a Shared Project's copy writes its Changes (#76),
/// one line each, without ever rewriting what it wrote before.
pub fn append_text(folder: &str, path: &str, text: &str) -> Result<(), String> {
    let file = resolve(folder, path)?;
    make_parent(&file)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .and_then(|mut handle| handle.write_all(text.as_bytes()))
        .map_err(|error| format!("{} could not be written: {error}", file.display()))
}

/// The whole lines a text file holds from byte `from` on, and the byte just
/// after them, where reading on starts next time.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Lines {
    pub text: String,
    pub end: u64,
}

/// Read the lines added to a file since byte `from`. A last line still being
/// written, with no newline yet, is left for next time. A file now shorter
/// than `from` was written anew, and is read from its start.
pub fn read_lines(folder: &str, path: &str, from: u64) -> Result<Lines, String> {
    let file = resolve(folder, path)?;
    let fail = |error: std::io::Error| format!("{} could not be read: {error}", file.display());
    let mut handle = fs::File::open(&file).map_err(fail)?;
    let size = handle.metadata().map_err(fail)?.len();
    let from = if size < from { 0 } else { from };
    handle.seek(SeekFrom::Start(from)).map_err(fail)?;
    let mut bytes = Vec::new();
    handle.read_to_end(&mut bytes).map_err(fail)?;
    let whole = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1);
    bytes.truncate(whole);
    Ok(Lines {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        end: from + whole as u64,
    })
}

/// Every file under `path` — "" for the whole folder — as folder-relative
/// paths in order. A path that isn't there has no files, which is not an error.
pub fn list_files(folder: &str, path: &str) -> Result<Vec<String>, String> {
    let root = resolve(folder, path)?;
    let prefix = match path.trim_end_matches('/') {
        "" | "." => String::new(),
        trimmed => format!("{trimmed}/"),
    };
    let mut files = Vec::new();
    collect(&root, &prefix, &mut files)?;
    files.sort();
    Ok(files)
}

/// Copy one file between Project folders, or within one, making folders as needed.
pub fn copy_file(
    from_folder: &str,
    from_path: &str,
    to_folder: &str,
    to_path: &str,
) -> Result<(), String> {
    let from = resolve(from_folder, from_path)?;
    let to = resolve(to_folder, to_path)?;
    make_parent(&to)?;
    fs::copy(&from, &to)
        .map(|_| ())
        .map_err(|error| format!("{} could not be copied: {error}", from.display()))
}

/// Delete a file. One that isn't there is already gone, which is not an error.
pub fn delete_file(folder: &str, path: &str) -> Result<(), String> {
    let file = resolve(folder, path)?;
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{} could not be deleted: {error}", file.display())),
    }
}

/// Make a folder, and everything above it, for a Project that is about to be
/// saved there.
pub fn make_folder(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("{} could not be made: {error}", path.display()))
}

fn make_parent(file: &Path) -> Result<(), String> {
    match file.parent() {
        Some(parent) => make_folder(parent),
        None => Ok(()),
    }
}

fn collect(at: &Path, prefix: &str, files: &mut Vec<String>) -> Result<(), String> {
    let entries = match fs::read_dir(at) {
        Ok(entries) => entries,
        // Nothing saved there yet: an empty Project folder, not a failure.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("{} could not be read: {error}", at.display())),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("{} could not be read: {error}", at.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = format!("{prefix}{name}");
        if entry.path().is_dir() {
            collect(&entry.path(), &format!("{path}/"), files)?;
        } else {
            files.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn folder(at: &TempDir) -> String {
        at.path().to_string_lossy().into_owned()
    }

    #[test]
    fn only_plain_relative_paths_inside_the_folder_are_resolved() {
        assert_eq!(
            resolve("/songs/first", "audio/take1.wav").unwrap(),
            PathBuf::from("/songs/first/audio/take1.wav")
        );
        assert_eq!(
            resolve("/songs/first", "./project.json").unwrap(),
            PathBuf::from("/songs/first/project.json")
        );
        assert_eq!(
            resolve("/songs/first", "").unwrap(),
            PathBuf::from("/songs/first")
        );

        for escaping in [
            "../secrets.txt",
            "audio/../../secrets.txt",
            "/etc/passwd",
            "..\\secrets.txt",
            "audio\\take1.wav",
        ] {
            assert!(
                resolve("/songs/first", escaping).is_err(),
                "{escaping} should not resolve"
            );
        }
    }

    #[test]
    fn a_project_folder_is_written_read_back_and_listed_in_full() {
        let at = TempDir::new().unwrap();
        let first = folder(&at);

        write_text(&first, "project.json", r#"{"schemaVersion":1}"#).unwrap();
        write_text(&first, "audio/take1.wav", "RIFF take 1").unwrap();
        write_text(&first, "audio/takes/take2.wav", "RIFF take 2").unwrap();

        assert_eq!(
            read_text(&first, "project.json").unwrap(),
            r#"{"schemaVersion":1}"#
        );
        assert_eq!(
            list_files(&first, "").unwrap(),
            [
                "audio/take1.wav".to_string(),
                "audio/takes/take2.wav".to_string(),
                "project.json".to_string(),
            ]
        );
        assert_eq!(list_files(&first, "audio").unwrap().len(), 2);
        // A folder with nothing in it yet is empty, not an error.
        assert!(list_files(&first, "renders").unwrap().is_empty());
        assert!(read_text(&first, "missing.json").is_err());
        assert!(list_files(&first, "../..").is_err());
    }

    #[test]
    fn a_wav_loaded_onto_a_pad_is_written_and_read_back_byte_for_byte() {
        let at = TempDir::new().unwrap();
        let folder = folder(&at);
        // A WAV's bytes are not text: they include zeroes and anything else.
        let wav: Vec<u8> = b"RIFF\0\0\0\0WAVE"
            .iter()
            .copied()
            .chain((0..=255u8).cycle().take(1000))
            .collect();

        write_bytes(&folder, "audio/kick.wav", &wav).unwrap();
        assert_eq!(read_bytes(&folder, "audio/kick.wav").unwrap(), wav);
        assert_eq!(list_files(&folder, "audio").unwrap(), ["audio/kick.wav"]);

        // Text and bytes read the same file, so a Project written by either
        // opens with the other.
        write_text(&folder, "audio/note.txt", "RIFF take 1").unwrap();
        assert_eq!(
            read_bytes(&folder, "audio/note.txt").unwrap(),
            b"RIFF take 1"
        );

        assert!(read_bytes(&folder, "audio/gone.wav").is_err());
        assert!(read_bytes(&folder, "../secrets.txt").is_err());
        assert!(write_bytes(&folder, "../secrets.wav", &wav).is_err());
    }

    #[test]
    fn audio_is_copied_into_a_project_folder_that_does_not_exist_yet() {
        let at = TempDir::new().unwrap();
        let first = folder(&at);
        write_text(&first, "audio/take1.wav", "RIFF take 1").unwrap();

        let second = at.path().join("elsewhere/second");
        make_folder(&second).unwrap();
        let second = second.to_string_lossy().into_owned();
        copy_file(&first, "audio/take1.wav", &second, "audio/take1.wav").unwrap();

        assert_eq!(
            read_text(&second, "audio/take1.wav").unwrap(),
            "RIFF take 1"
        );
        assert!(copy_file(&first, "../../secrets.txt", &second, "audio/x.wav").is_err());
        assert!(copy_file(&first, "audio/gone.wav", &second, "audio/gone.wav").is_err());
    }

    #[test]
    fn appended_lines_are_read_once_each_and_a_line_still_being_written_waits() {
        let at = TempDir::new().unwrap();
        let shared = folder(&at);

        append_text(&shared, "changes/alice.jsonl", "{\"seq\":1}\n").unwrap();
        append_text(&shared, "changes/alice.jsonl", "{\"seq\":2}\n{\"se").unwrap();
        let first = read_lines(&shared, "changes/alice.jsonl", 0).unwrap();
        assert_eq!(first.text, "{\"seq\":1}\n{\"seq\":2}\n");
        assert_eq!(first.end, 20);

        append_text(&shared, "changes/alice.jsonl", "q\":3}\n").unwrap();
        let next = read_lines(&shared, "changes/alice.jsonl", first.end).unwrap();
        assert_eq!(next.text, "{\"seq\":3}\n");
        assert_eq!(
            read_lines(&shared, "changes/alice.jsonl", next.end)
                .unwrap()
                .text,
            ""
        );

        // Written anew, shorter than where reading had got to: read from the start.
        write_text(&shared, "changes/alice.jsonl", "{\"seq\":9}\n").unwrap();
        let again = read_lines(&shared, "changes/alice.jsonl", next.end).unwrap();
        assert_eq!(
            again,
            Lines {
                text: "{\"seq\":9}\n".into(),
                end: 10
            }
        );
        assert!(read_lines(&shared, "changes/bob.jsonl", 0).is_err());
        assert!(append_text(&shared, "../outside.jsonl", "x").is_err());
    }

    #[test]
    fn a_folder_that_has_been_moved_reads_the_same_as_where_it_was_saved() {
        let at = TempDir::new().unwrap();
        let first = at.path().join("songs/first");
        make_folder(&first).unwrap();
        let first = first.to_string_lossy().into_owned();
        write_text(
            &first,
            "project.json",
            r#"{"schemaVersion":1,"name":"Demo"}"#,
        )
        .unwrap();
        write_text(&first, "audio/take1.wav", "RIFF take 1").unwrap();

        // As moving the folder in a file manager would leave it.
        let moved = at.path().join("backup/first");
        make_folder(moved.parent().unwrap()).unwrap();
        fs::rename(&first, &moved).unwrap();
        let moved = moved.to_string_lossy().into_owned();

        assert_eq!(
            read_text(&moved, "project.json").unwrap(),
            r#"{"schemaVersion":1,"name":"Demo"}"#
        );
        assert_eq!(read_text(&moved, "audio/take1.wav").unwrap(), "RIFF take 1");
    }
}
