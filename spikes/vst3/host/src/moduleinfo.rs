//! A bundle's `Contents/Resources/moduleinfo.json`, which VST3 SDK 3.7 and
//! later write when a Plugin is built. It lists the bundle's classes, so a scan
//! can learn what a bundle holds without loading, and so running, any of its
//! code. It is JSON5 (trailing commas), not JSON.

use std::path::Path;

use serde::Deserialize;

/// The category of a class that is an Instrument or Effect, as opposed to its
/// controller or anything else a factory makes.
pub const AUDIO_MODULE_CLASS: &str = "Audio Module Class";

/// One class a bundle's factory can make.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Class {
    /// Its class id: 32 hex digits, as the helper prints them.
    pub cid: String,
    pub category: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    /// Such as `Fx`, `Instrument` and `Synth`.
    pub sub_categories: Vec<String>,
}

impl Class {
    /// An Instrument, rather than an Effect.
    pub fn is_instrument(&self) -> bool {
        self.sub_categories.iter().any(|sub| sub == "Instrument")
    }
}

#[derive(Deserialize)]
struct ModuleInfo {
    #[serde(rename = "Factory Info")]
    factory: Option<FactoryInfo>,
    #[serde(rename = "Classes", default)]
    classes: Vec<RawClass>,
}

#[derive(Deserialize)]
struct FactoryInfo {
    #[serde(rename = "Vendor", default)]
    vendor: String,
}

#[derive(Deserialize)]
struct RawClass {
    #[serde(rename = "CID")]
    cid: String,
    #[serde(rename = "Category", default)]
    category: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Vendor", default)]
    vendor: String,
    #[serde(rename = "Version", default)]
    version: String,
    #[serde(rename = "Sub Categories", default)]
    sub_categories: Vec<String>,
}

/// Every class `text` lists, or why it can't be read.
pub fn parse(text: &str) -> Result<Vec<Class>, String> {
    let info: ModuleInfo = json5::from_str(text).map_err(|error| error.to_string())?;
    let factory_vendor = info.factory.map(|f| f.vendor).unwrap_or_default();
    Ok(info
        .classes
        .into_iter()
        .map(|raw| Class {
            cid: raw.cid.to_ascii_uppercase(),
            category: raw.category,
            name: raw.name,
            vendor: if raw.vendor.is_empty() {
                factory_vendor.clone()
            } else {
                raw.vendor
            },
            version: raw.version,
            sub_categories: raw.sub_categories,
        })
        .collect())
}

/// The bundle's classes from its moduleinfo, or `None` if it has none (a
/// Plugin built before SDK 3.7) or it can't be read.
pub fn read(bundle: &Path) -> Option<Vec<Class>> {
    let path = bundle.join("Contents/Resources/moduleinfo.json");
    let text = std::fs::read_to_string(path).ok()?;
    parse(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGAIN: &str = r#"{
  "Name": "again-sample-accurate",
  "Version": "3.8.1.0",
  "Factory Info": {
    "Vendor": "Steinberg Media Technologies",
    "Flags": { "Unicode": true, },
  },
  "Classes": [
    {
      "CID": "c18d3c1e719e4e29924d3ecaa5e4da18",
      "Category": "Audio Module Class",
      "Name": "AGain Sample Accurate",
      "Vendor": "Steinberg Media Technologies",
      "Version": "3.8.1.0",
      "Sub Categories": [ "Fx", ],
    },
    {
      "CID": "C244B7E624084E20A24A8C43F84C8BE8",
      "Category": "Component Controller Class",
      "Name": "AGain Sample AccurateController",
      "Version": "3.8.1.0",
    },
  ],
}"#;

    #[test]
    fn reads_the_classes_despite_trailing_commas() {
        let classes = parse(AGAIN).unwrap();
        assert_eq!(classes.len(), 2);
        assert_eq!(classes[0].cid, "C18D3C1E719E4E29924D3ECAA5E4DA18");
        assert_eq!(classes[0].category, AUDIO_MODULE_CLASS);
        assert_eq!(classes[0].name, "AGain Sample Accurate");
        assert_eq!(classes[0].sub_categories, ["Fx"]);
        assert!(!classes[0].is_instrument());
    }

    #[test]
    fn a_class_without_a_vendor_takes_the_factorys() {
        let classes = parse(AGAIN).unwrap();
        assert_eq!(classes[1].vendor, "Steinberg Media Technologies");
    }

    #[test]
    fn says_why_it_cannot_read_one() {
        assert!(parse("{ \"Classes\": [ { \"Name\": 3 } ] }").is_err());
        assert!(parse("not json").is_err());
    }
}
