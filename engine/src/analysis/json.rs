//! An Analysis as compact JSON, written by hand: the shape is small and
//! fixed, and the engine keeps its dependencies few.
//!
//! Positions are `{"s":seconds,"at":"bar.beat"}`. Levels that are `-inf`
//! (silence) are `null`, as is a key or tempo that wasn't found.

use std::fmt::Write;

use super::{Analysis, BANDS, Position, Source};

pub fn write(analysis: &Analysis) -> String {
    let mut out = String::with_capacity(1_024);
    let source = match analysis.source {
        Source::Mix => "mix".to_string(),
        Source::Track(index) => format!("track {index}"),
        Source::File => "file".to_string(),
    };
    let _ = write!(
        out,
        r#"{{"source":"{source}","start":{},"end":{}"#,
        position(&analysis.start),
        position(&analysis.end),
    );

    let short_term = list(analysis.short_term_lufs.iter().map(|(at, lufs)| {
        format!(
            r#"{{"s":{},"at":"{}","lufs":{}}}"#,
            seconds(at.seconds),
            at.label(),
            level(*lufs)
        )
    }));
    let _ = write!(
        out,
        r#","loudness":{{"integrated_lufs":{},"max_short_term_lufs":{},"short_term":{short_term}}}"#,
        level(analysis.integrated_lufs),
        level(analysis.max_short_term_lufs),
    );
    let _ = write!(
        out,
        r#","rms_db":{},"sample_peak_db":{},"true_peak_dbtp":{}"#,
        level(analysis.rms_db.into()),
        level(analysis.sample_peak_db.into()),
        level(analysis.true_peak_db.into()),
    );

    let regions = list(analysis.clipping.iter().map(|r| {
        format!(
            r#"{{"start":{},"end":{}}}"#,
            position(&r.start),
            position(&r.end)
        )
    }));
    let _ = write!(
        out,
        r#","clipping":{{"clipped_samples":{},"region_count":{},"regions":{regions}}}"#,
        analysis.clipped_frames, analysis.clip_region_count,
    );

    let bands = BANDS
        .iter()
        .zip(analysis.bands_db)
        .map(|(band, db)| format!(r#""{}":{}"#, band.name, level(db.into())))
        .collect::<Vec<_>>()
        .join(",");
    let _ = write!(out, r#","bands_db":{{{bands}}}"#);

    let key = analysis.key.map_or("null".to_string(), |key| {
        format!(
            r#"{{"name":"{}","confidence":{}}}"#,
            key.name(),
            fraction(key.confidence)
        )
    });
    let tempo = analysis.tempo.map_or("null".to_string(), |tempo| {
        format!(
            r#"{{"bpm":{},"confidence":{}}}"#,
            round(tempo.bpm, 10.0),
            fraction(tempo.confidence)
        )
    });
    let onsets = list(analysis.onsets.iter().map(position));
    let _ = write!(
        out,
        r#","key":{key},"tempo":{tempo},"onsets":{{"count":{},"at":{onsets}}}}}"#,
        analysis.onset_count,
    );
    out
}

fn position(at: &Position) -> String {
    format!(r#"{{"s":{},"at":"{}"}}"#, seconds(at.seconds), at.label())
}

fn list(items: impl Iterator<Item = String>) -> String {
    format!("[{}]", items.collect::<Vec<_>>().join(","))
}

/// A level to 0.1 dB, or `null` for silence.
fn level(db: f64) -> String {
    if db.is_finite() {
        round(db, 10.0)
    } else {
        "null".to_string()
    }
}

fn seconds(value: f64) -> String {
    round(value, 1_000.0)
}

fn fraction(value: f64) -> String {
    round(value, 100.0)
}

/// `value` rounded to `1 / scale`, written without trailing zeros.
fn round(value: f64, scale: f64) -> String {
    let rounded = (value * scale).round() / scale;
    // Avoid "-0", which reads as a sign that means something.
    format!("{}", if rounded == 0.0 { 0.0 } else { rounded })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_rounded_and_silence_is_null() {
        assert_eq!(level(-14.249), "-14.2");
        assert_eq!(level(f64::NEG_INFINITY), "null");
        assert_eq!(seconds(2.000_4), "2");
        assert_eq!(seconds(-0.000_1), "0");
        assert_eq!(fraction(0.876), "0.88");
    }
}
