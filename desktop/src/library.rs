//! The app-level library, outside any Project (#50): the musician's User
//! Presets and saved Kits (#51), with the Kits' samples, kept in the
//! app-data folder so every Project can load them.
//!
//! It is a folder like a Project's, read and written through the same
//! functions, so every path the UI names is resolved inside it and refused
//! if it could lead out.

use std::path::Path;

/// The library's folder inside the app's own data folder.
pub fn folder(app_data: &Path) -> String {
    app_data.join("library").to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_files::{
        delete_file, list_files, read_bytes, read_text, write_bytes, write_text,
    };
    use tempfile::TempDir;

    #[test]
    fn a_preset_is_written_listed_read_back_and_deleted() {
        let app_data = TempDir::new().unwrap();
        let library = folder(app_data.path());
        assert_eq!(
            list_files(&library, "presets").unwrap(),
            Vec::<String>::new()
        );

        write_text(&library, "presets/one.json", "{\"name\":\"Warm\"}").unwrap();
        assert_eq!(
            list_files(&library, "presets").unwrap(),
            ["presets/one.json"]
        );
        assert_eq!(
            read_text(&library, "presets/one.json").unwrap(),
            "{\"name\":\"Warm\"}"
        );
        assert!(app_data.path().join("library/presets/one.json").is_file());

        delete_file(&library, "presets/one.json").unwrap();
        assert_eq!(
            list_files(&library, "presets").unwrap(),
            Vec::<String>::new()
        );
        // Already gone: deleting it again is not an error.
        delete_file(&library, "presets/one.json").unwrap();
    }

    #[test]
    fn a_kit_and_its_sample_are_written_and_read_back_byte_for_byte() {
        let app_data = TempDir::new().unwrap();
        let library = folder(app_data.path());
        let wav: Vec<u8> = (0..=255).collect();
        write_text(&library, "kits/one/kit.json", "{\"name\":\"Mine\"}").unwrap();
        write_bytes(&library, "kits/one/audio/kick.wav", &wav).unwrap();
        assert_eq!(
            list_files(&library, "kits").unwrap(),
            ["kits/one/audio/kick.wav", "kits/one/kit.json"]
        );
        assert_eq!(
            read_bytes(&library, "kits/one/audio/kick.wav").unwrap(),
            wav
        );
        assert!(write_bytes(&library, "../kick.wav", &wav).is_err());
    }

    #[test]
    fn nothing_outside_the_library_can_be_reached() {
        let app_data = TempDir::new().unwrap();
        let library = folder(app_data.path());
        std::fs::write(app_data.path().join("secret.txt"), "keep").unwrap();
        assert!(read_text(&library, "../secret.txt").is_err());
        assert!(write_text(&library, "../secret.txt", "gone").is_err());
        assert!(delete_file(&library, "../secret.txt").is_err());
        assert!(app_data.path().join("secret.txt").is_file());
    }
}
