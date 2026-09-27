//! The sample browser's side of the desktop app (#52): the audio files in a
//! folder the musician has added, and reading one to audition it.
//!
//! A sample folder is read through the same functions as a Project folder,
//! so every path the UI names is resolved inside it and refused if it could
//! lead out. Which folders there are is the UI's, kept in the app's library.

use crate::project_files;

/// The kinds of file the engine can play, as the UI's import offers them.
const AUDIO_EXTENSIONS: [&str; 3] = ["wav", "flac", "mp3"];

/// Whether `path` names a file the engine can play, by its extension.
pub fn is_audio(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        AUDIO_EXTENSIONS
            .iter()
            .any(|audio| extension.eq_ignore_ascii_case(audio))
    })
}

/// Every audio file anywhere in `folder`, as folder-relative paths in order.
pub fn list_audio(folder: &str) -> Result<Vec<String>, String> {
    let mut files = project_files::list_files(folder, "")?;
    files.retain(|path| is_audio(path));
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn only_audio_files_are_listed_from_every_folder_inside() {
        let root = TempDir::new().unwrap();
        let folder = root.path().to_string_lossy().into_owned();
        for path in [
            "kick.wav",
            "Loops/Beat.FLAC",
            "Loops/deep/bass.mp3",
            "notes.txt",
            "Loops/cover.png",
            "wav",
        ] {
            project_files::write_bytes(&folder, path, b"x").unwrap();
        }
        assert_eq!(
            list_audio(&folder).unwrap(),
            ["Loops/Beat.FLAC", "Loops/deep/bass.mp3", "kick.wav"]
        );
    }

    #[test]
    fn nothing_outside_a_sample_folder_can_be_read() {
        let root = TempDir::new().unwrap();
        let folder = root.path().join("samples");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(root.path().join("secret.wav"), "keep").unwrap();
        let folder = folder.to_string_lossy().into_owned();
        assert!(project_files::read_bytes(&folder, "../secret.wav").is_err());
    }
}
