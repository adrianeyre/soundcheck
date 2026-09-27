//! The machine's credential store, where the Claude API key is kept.
//!
//! Windows Credential Manager on Windows (the MVP's platform, ADR 0002),
//! Keychain on macOS and the Secret Service on Linux, all through `keyring`.
//! The key is never written into a Project.

/// Both parts name the entry in the OS store; they must stay put, or an
/// already-saved key becomes unreadable.
const SERVICE: &str = "com.adrianeyre.soundcheck";
const ACCOUNT: &str = "claude-api-key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(describe)
}

/// The saved Claude API key, or None when there isn't one yet.
pub fn read() -> Result<Option<String>, String> {
    found(entry()?.get_password())
}

pub fn write(key: &str) -> Result<(), String> {
    entry()?.set_password(key).map_err(describe)
}

/// Forget the key. Forgetting one that was never there is not an error.
pub fn delete() -> Result<(), String> {
    found(entry()?.delete_credential())?;
    Ok(())
}

/// "Nothing saved" is an answer, not a failure: the UI asks for the key.
fn found<T>(result: keyring::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(describe(error)),
    }
}

/// Credential-store errors are platform-specific; say which store failed so
/// the message in the UI is worth reading.
fn describe(error: keyring::Error) -> String {
    format!("The credential store could not be used: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_that_was_never_saved_reads_as_none_rather_than_an_error() {
        assert_eq!(found(Err::<String, _>(keyring::Error::NoEntry)), Ok(None));
    }

    #[test]
    fn any_other_failure_says_the_credential_store_is_to_blame() {
        let error = found(Err::<String, _>(keyring::Error::Ambiguous(Vec::new())))
            .expect_err("an ambiguous credential is a failure");
        assert!(error.starts_with("The credential store could not be used:"));
    }
}
