//! A VST3 Plugin as the Project would keep it: which Plugin it is, and the
//! state it gave, as base64 so `project.json` stays text. The state is the
//! Plugin's own and opaque: Soundcheck keeps it exactly and hands it back,
//! and never reads inside it.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::moduleinfo::Class;
use crate::process::State;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVst3 {
    /// Its class id, which is how it is found again on this or another
    /// machine, wherever its bundle is installed.
    pub cid: String,
    /// Shown when it isn't installed, so the musician knows what to get.
    pub name: String,
    pub vendor: String,
    /// The version that saved the state.
    pub version: String,
    pub component_state: String,
    pub controller_state: String,
}

impl SavedVst3 {
    pub fn new(class: &Class, state: &State) -> Self {
        Self {
            cid: class.cid.clone(),
            name: class.name.clone(),
            vendor: class.vendor.clone(),
            version: class.version.clone(),
            component_state: STANDARD.encode(&state.component),
            controller_state: STANDARD.encode(&state.controller),
        }
    }

    /// The state to hand back to the Plugin, or `None` if it was damaged.
    pub fn state(&self) -> Option<State> {
        Some(State {
            component: STANDARD.decode(&self.component_state).ok()?,
            controller: STANDARD.decode(&self.controller_state).ok()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goes_through_project_json_unchanged() {
        let class = Class {
            cid: "C18D3C1E719E4E29924D3ECAA5E4DA18".into(),
            category: "Audio Module Class".into(),
            name: "AGain".into(),
            vendor: "Steinberg Media Technologies".into(),
            version: "3.8.1.0".into(),
            sub_categories: vec!["Fx".into()],
        };
        let state = State {
            component: vec![0, 1, 2, 0xff, b'\t', b'\n'],
            controller: vec![],
        };
        let saved = SavedVst3::new(&class, &state);
        let json = serde_json::to_string(&saved).unwrap();
        assert!(json.contains(r#""componentState":"AAEC/wkK""#), "{json}");
        let back: SavedVst3 = serde_json::from_str(&json).unwrap();
        assert_eq!(back, saved);
        assert_eq!(back.state().unwrap(), state);
    }
}
