//! A picture of analysed audio, for an Assistant that can take images but
//! not sound: a spectrogram on a log-frequency axis against bars and beats,
//! the waveform above it and a dB scale beside it, encoded as PNG.
//!
//! It is drawn from the same render as the measurements, and labelled with
//! the built-in 3×5 font, so it needs no canvas, font or image library
//! beyond the PNG encoder.

use super::Timeline;
use super::fft::{Spectrogram, frame_size};
use super::glyphs;

/// The picture's size in pixels. Small enough to cost Claude few tokens,
/// large enough to read bars and octaves from.
pub const WIDTH: usize = 800;
pub const HEIGHT: usize = 400;

/// The plot area: frequency labels to its left, the dB scale to its right,
/// the waveform strip above the spectrogram, bar labels below.
const LEFT: usize = 48;
const PLOT_WIDTH: usize = 692;
const WAVE_TOP: usize = 8;
const WAVE_HEIGHT: usize = 60;
const SPECTRUM_TOP: usize = WAVE_TOP + WAVE_HEIGHT + 8;
const SPECTRUM_HEIGHT: usize = 288;
const SPECTRUM_BOTTOM: usize = SPECTRUM_TOP + SPECTRUM_HEIGHT;
const SCALE_LEFT: usize = LEFT + PLOT_WIDTH + 10;
const SCALE_WIDTH: usize = 10;

/// The frequency axis, in hertz, and the frequencies labelled on it.
const LOWEST_HZ: f64 = 20.0;
const HIGHEST_HZ: f64 = 20_000.0;
const FREQUENCY_LABELS: [(f64, &str); 8] = [
    (50.0, "50"),
    (100.0, "100"),
    (200.0, "200"),
    (500.0, "500"),
    (1_000.0, "1k"),
    (2_000.0, "2k"),
    (5_000.0, "5k"),
    (10_000.0, "10k"),
];
/// The quietest level shown, in dB relative to a full-scale sine; anything
/// quieter is the darkest colour.
const FLOOR_DB: f64 = -90.0;
const DB_LABELS: [(f64, &str); 4] = [(0.0, "0"), (-30.0, "-30"), (-60.0, "-60"), (-90.0, "-90")];
/// Frames of about 85 ms: fine enough in time for beats, in frequency for
/// the low mids.
const FRAME_SECONDS: f32 = 0.085;
/// Labels on the time axis are at least this many pixels apart.
const MIN_LABEL_GAP: f64 = 36.0;
/// Each font pixel is drawn this many pixels square.
const TEXT_SCALE: usize = 2;

const BACKGROUND: [u8; 3] = [16, 16, 16];
const PANEL: [u8; 3] = [32, 32, 32];
const TEXT: [u8; 3] = [224, 224, 224];
const GRID: [u8; 3] = [150, 150, 150];
const WAVE: [u8; 3] = [140, 190, 255];
const CLIPPED: [u8; 3] = [255, 60, 60];

/// Draw `left` and `right` (the same length) at `sample_rate`, placed in the
/// song by `timeline`, as a PNG file.
pub fn spectrogram_png(
    left: &[f32],
    right: &[f32],
    sample_rate: f32,
    timeline: &Timeline,
) -> Vec<u8> {
    let mut canvas = Canvas::new();
    let mono: Vec<f32> = left.iter().zip(right).map(|(l, r)| 0.5 * (l + r)).collect();
    draw_spectrum(&mut canvas, &mono, sample_rate);
    draw_wave(&mut canvas, left, right);
    let seconds = left.len() as f64 / f64::from(sample_rate);
    draw_axes(&mut canvas, timeline, seconds, sample_rate);
    canvas.png()
}

/// RGB pixels, row by row.
struct Canvas {
    pixels: Vec<u8>,
}

impl Canvas {
    fn new() -> Self {
        Self {
            pixels: BACKGROUND.repeat(WIDTH * HEIGHT),
        }
    }

    fn set(&mut self, x: usize, y: usize, colour: [u8; 3]) {
        if x < WIDTH && y < HEIGHT {
            let at = (y * WIDTH + x) * 3;
            self.pixels[at..at + 3].copy_from_slice(&colour);
        }
    }

    fn fill(&mut self, x: usize, y: usize, width: usize, height: usize, colour: [u8; 3]) {
        for row in y..y + height {
            for column in x..x + width {
                self.set(column, row, colour);
            }
        }
    }

    /// `text` with its top-left corner at `x`, `y`.
    fn text(&mut self, x: usize, y: usize, text: &str) {
        for (i, c) in text.chars().enumerate() {
            let left = x + i * (glyphs::WIDTH + 1) * TEXT_SCALE;
            for (row, bits) in glyphs::glyph(c).iter().enumerate() {
                for column in 0..glyphs::WIDTH {
                    if bits & (1 << (glyphs::WIDTH - 1 - column)) != 0 {
                        let (px, py) = (left + column * TEXT_SCALE, y + row * TEXT_SCALE);
                        self.fill(px, py, TEXT_SCALE, TEXT_SCALE, TEXT);
                    }
                }
            }
        }
    }

    fn png(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, WIDTH as u32, HEIGHT as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        // Writing to memory can only fail on a size mismatch, which the
        // constants rule out.
        let mut writer = encoder.write_header().expect("a PNG header");
        writer
            .write_image_data(&self.pixels)
            .expect("PNG image data");
        writer.finish().expect("a PNG file");
        out
    }
}

/// How wide `text` is when drawn.
fn text_width(text: &str) -> usize {
    (text.chars().count() * (glyphs::WIDTH + 1)).saturating_sub(1) * TEXT_SCALE
}

const TEXT_HEIGHT: usize = glyphs::HEIGHT * TEXT_SCALE;

/// The spectrogram row `hz` is drawn at, counting down from the top of the
/// spectrogram. Rows are spaced evenly in log frequency, highest at the top.
fn frequency_row(hz: f64) -> f64 {
    (HIGHEST_HZ / hz).ln() / (HIGHEST_HZ / LOWEST_HZ).ln() * SPECTRUM_HEIGHT as f64
}

/// Which bins make up one row: every bin inside it, or where between two
/// bins its centre falls when it is narrower than a bin.
enum RowBins {
    Span(usize, usize),
    Between(usize, f64),
}

impl RowBins {
    fn for_rows(spectrogram: &Spectrogram) -> Vec<Self> {
        let bin_hz = spectrogram.frequency(1);
        let last = spectrogram.size / 2;
        let hz_at =
            |row: f64| HIGHEST_HZ * (LOWEST_HZ / HIGHEST_HZ).powf(row / SPECTRUM_HEIGHT as f64);
        (0..SPECTRUM_HEIGHT)
            .map(|row| {
                let (high, low) = (hz_at(row as f64), hz_at(row as f64 + 1.0));
                let first = ((low / bin_hz).ceil() as usize).min(last);
                let end = ((high / bin_hz).floor() as usize).min(last);
                if first <= end {
                    RowBins::Span(first, end)
                } else {
                    let at = ((low * high).sqrt() / bin_hz).min(last as f64 - 1.0);
                    RowBins::Between(at.floor() as usize, at.fract())
                }
            })
            .collect()
    }

    fn power(&self, frame: &[f64]) -> f64 {
        match *self {
            RowBins::Span(first, end) => frame[first..=end].iter().copied().fold(0.0, f64::max),
            RowBins::Between(bin, fraction) => {
                frame[bin] * (1.0 - fraction) + frame[bin + 1] * fraction
            }
        }
    }
}

/// The level of power `power` in a bin of `size`-sample Hann frames, in dB
/// relative to a full-scale sine's peak bin.
fn bin_db(power: f64, size: usize) -> f64 {
    // A sine of amplitude A peaks at A · Σw / 2 = A · size / 4.
    10.0 * (power * 16.0 / (size * size) as f64).max(1e-30).log10()
}

fn draw_spectrum(canvas: &mut Canvas, mono: &[f32], sample_rate: f32) {
    let size = frame_size(sample_rate, FRAME_SECONDS);
    // About one frame per column, however long the range: more for a short
    // one (up to half-overlapping frames), averaged, for a long one.
    let hop = (mono.len() / PLOT_WIDTH).clamp(64, size / 2);
    let spectrogram = Spectrogram::new(mono, sample_rate, size, hop);
    let rows = RowBins::for_rows(&spectrogram);
    let count = spectrogram.frames.len();
    let rate = f64::from(sample_rate);
    let seconds = mono.len().max(1) as f64 / rate;
    // The frame whose middle is `t` seconds in, as a real number.
    let frame_at = |t: f64| (t * rate - (size / 2) as f64) / hop as f64;

    for column in 0..PLOT_WIDTH {
        let t = |edge: f64| edge / PLOT_WIDTH as f64 * seconds;
        let first = frame_at(t(column as f64)).ceil().max(0.0) as usize;
        let end = (frame_at(t(column as f64 + 1.0)).ceil().max(0.0) as usize).min(count);
        let frames = if first < end {
            first..end
        } else {
            let nearest =
                (frame_at(t(column as f64 + 0.5)).round().max(0.0) as usize).min(count - 1);
            nearest..nearest + 1
        };
        let mut powers = vec![0.0; SPECTRUM_HEIGHT];
        for frame in &spectrogram.frames[frames.clone()] {
            for (power, bins) in powers.iter_mut().zip(&rows) {
                *power += bins.power(frame);
            }
        }
        for (row, power) in powers.iter().enumerate() {
            let db = bin_db(power / frames.len() as f64, size);
            canvas.set(LEFT + column, SPECTRUM_TOP + row, heat(1.0 - db / FLOOR_DB));
        }
    }

    for row in 0..SPECTRUM_HEIGHT {
        let level = 1.0 - row as f64 / (SPECTRUM_HEIGHT - 1) as f64;
        canvas.fill(SCALE_LEFT, SPECTRUM_TOP + row, SCALE_WIDTH, 1, heat(level));
    }
}

/// Each column's lowest and highest sample over both channels, red where
/// either channel is at or beyond full scale.
fn draw_wave(canvas: &mut Canvas, left: &[f32], right: &[f32]) {
    canvas.fill(LEFT, WAVE_TOP, PLOT_WIDTH, WAVE_HEIGHT, PANEL);
    let middle = WAVE_TOP + WAVE_HEIGHT / 2;
    canvas.fill(LEFT, middle, PLOT_WIDTH, 1, BACKGROUND);
    let y = |sample: f32| {
        let level = f64::from(sample.clamp(-1.0, 1.0));
        WAVE_TOP + ((1.0 - level) / 2.0 * (WAVE_HEIGHT - 1) as f64).round() as usize
    };
    let frames = left.len();
    if frames == 0 {
        return;
    }
    for column in 0..PLOT_WIDTH {
        let first = (column * frames / PLOT_WIDTH).min(frames - 1);
        let end = ((column + 1) * frames / PLOT_WIDTH).clamp(first + 1, frames);
        let samples = left[first..end].iter().chain(&right[first..end]);
        let (low, high, clipped) = samples
            .fold((0.0f32, 0.0f32, false), |(low, high, clipped), &s| {
                (low.min(s), high.max(s), clipped || s.abs() >= 1.0)
            });
        let colour = if clipped { CLIPPED } else { WAVE };
        for row in y(high)..=y(low) {
            canvas.set(LEFT + column, row, colour);
        }
    }
}

/// A label on the time axis: its x within the plot, and what it says.
#[derive(Debug, PartialEq)]
struct TimeLabel {
    x: usize,
    text: String,
}

/// Every beat, labelled "bar.beat" ("1" on the downbeat), when there is room;
/// otherwise every bar, or every second, fourth or eighth bar and so on.
fn time_labels(timeline: &Timeline, seconds: f64) -> Vec<TimeLabel> {
    let map = &timeline.tempo_map;
    let seconds = seconds.max(1e-3);
    let start = timeline.start_tick;
    let end = timeline.tick_at(seconds);
    let pixels_per_second = PLOT_WIDTH as f64 / seconds;
    let x_of =
        |tick: u64| (map.seconds_at(tick as f64) - map.seconds_at(start)) * pixels_per_second;

    let mut beats = Vec::new();
    let mut tick = start.max(0.0).ceil() as u64;
    loop {
        let beat = map.next_beat(tick);
        if beat as f64 > end + 0.5 {
            break;
        }
        beats.push(beat);
        tick = beat + 1;
    }
    let fits = |ticks: &[u64]| {
        ticks
            .windows(2)
            .all(|w| x_of(w[1]) - x_of(w[0]) >= MIN_LABEL_GAP)
    };
    let shown = if fits(&beats) {
        beats
    } else {
        let bars: Vec<(u64, u64)> = beats
            .into_iter()
            .filter(|&tick| map.beat_at(tick) == Some(true))
            .map(|tick| (tick, map.bar_and_beat(tick as f64).0))
            .collect();
        let mut every = 1;
        loop {
            let chosen: Vec<u64> = bars
                .iter()
                .filter(|(_, bar)| (bar - 1).is_multiple_of(every))
                .map(|&(tick, _)| tick)
                .collect();
            if chosen.len() <= 1 || fits(&chosen) {
                break chosen;
            }
            every *= 2;
        }
    };

    shown
        .into_iter()
        .map(|tick| {
            let position = timeline.position(x_of(tick) / pixels_per_second);
            let text = if position.beat == 1 {
                position.bar.to_string()
            } else {
                position.label()
            };
            let x = (x_of(tick).round().max(0.0) as usize).min(PLOT_WIDTH - 1);
            TimeLabel { x, text }
        })
        .collect()
}

fn draw_axes(canvas: &mut Canvas, timeline: &Timeline, seconds: f64, sample_rate: f32) {
    let label_row = SPECTRUM_BOTTOM + 8;
    for TimeLabel { x, text } in time_labels(timeline, seconds) {
        let x = LEFT + x;
        // Dotted, so the spectrogram still reads through the line.
        for y in (WAVE_TOP..SPECTRUM_BOTTOM).step_by(4) {
            if !(WAVE_TOP + WAVE_HEIGHT..SPECTRUM_TOP).contains(&y) {
                canvas.set(x, y, GRID);
            }
        }
        canvas.fill(x, SPECTRUM_BOTTOM, 1, 5, TEXT);
        let width = text_width(&text);
        let text_x = x.saturating_sub(width / 2).min(SCALE_LEFT - width);
        canvas.text(text_x, label_row, &text);
    }
    canvas.text(4, label_row, "bar");

    let nyquist = f64::from(sample_rate) / 2.0;
    for (hz, text) in FREQUENCY_LABELS.iter().filter(|(hz, _)| *hz < nyquist) {
        let y = SPECTRUM_TOP + frequency_row(*hz).round() as usize;
        canvas.fill(LEFT - 4, y, 4, 1, TEXT);
        canvas.text(LEFT - 6 - text_width(text), y - TEXT_HEIGHT / 2, text);
    }
    canvas.text(4, SPECTRUM_TOP, "Hz");
    canvas.text(4, WAVE_TOP + (WAVE_HEIGHT - TEXT_HEIGHT) / 2, "wave");

    let scale_labels = SCALE_LEFT + SCALE_WIDTH + 4;
    for (db, text) in DB_LABELS {
        let y = SPECTRUM_TOP + (db / FLOOR_DB * (SPECTRUM_HEIGHT - 1) as f64).round() as usize;
        let y = y
            .saturating_sub(TEXT_HEIGHT / 2)
            .clamp(SPECTRUM_TOP, SPECTRUM_BOTTOM - TEXT_HEIGHT);
        canvas.text(scale_labels, y, text);
    }
    canvas.text(SCALE_LEFT, label_row, "dB");
}

/// A dark-to-bright colour map for `level` from 0 to 1, rising in lightness
/// all the way so brighter always means louder.
fn heat(level: f64) -> [u8; 3] {
    const STOPS: [[f64; 3]; 8] = [
        [0.0, 0.0, 4.0],
        [40.0, 11.0, 84.0],
        [101.0, 21.0, 110.0],
        [159.0, 42.0, 99.0],
        [212.0, 72.0, 66.0],
        [245.0, 125.0, 21.0],
        [250.0, 193.0, 39.0],
        [252.0, 255.0, 164.0],
    ];
    let at = level.clamp(0.0, 1.0) * (STOPS.len() - 1) as f64;
    let low = (at.floor() as usize).min(STOPS.len() - 2);
    let fraction = at - low as f64;
    let (a, b) = (STOPS[low], STOPS[low + 1]);
    std::array::from_fn(|i| (a[i] + (b[i] - a[i]) * fraction).round() as u8)
}

/// Standard base64, padded, as Claude's image input takes it.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = chunk
            .iter()
            .enumerate()
            .fold(0u32, |w, (i, &b)| w | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                char::from(ALPHABET[(word >> (18 - 6 * i) & 63) as usize])
            } else {
                '='
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;
    use crate::transport::TimeSignature;

    const RATE: f32 = 48_000.0;
    /// At 120 bpm in 4/4, a bar is two seconds.
    const BAR_FRAMES: usize = 96_000;

    fn timeline(start_tick: f64) -> Timeline {
        Timeline {
            start_tick,
            tempo_map: crate::tempo_map::TempoMap::default(),
        }
    }

    /// The picture as RGB pixels, decoded again.
    fn decode(png: &[u8]) -> Vec<u8> {
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let mut reader = decoder.read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((info.width, info.height), (WIDTH as u32, HEIGHT as u32));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        pixels
    }

    fn pixel(pixels: &[u8], x: usize, y: usize) -> [u8; 3] {
        let at = (y * WIDTH + x) * 3;
        [pixels[at], pixels[at + 1], pixels[at + 2]]
    }

    fn brightness([r, g, b]: [u8; 3]) -> u32 {
        u32::from(r) + u32::from(g) + u32::from(b)
    }

    /// A column clear of the dotted lines on the beats.
    fn between_beats(fraction: f64) -> usize {
        LEFT + (fraction * PLOT_WIDTH as f64) as usize + 10
    }

    fn picture(samples: &[f32]) -> Vec<u8> {
        decode(&spectrogram_png(samples, samples, RATE, &timeline(0.0)))
    }

    #[test]
    fn a_sine_is_a_bright_line_at_its_frequency() {
        let pixels = picture(&sine(1_000.0, 0.5, RATE, BAR_FRAMES));
        let column = between_beats(0.5);
        let brightest = (SPECTRUM_TOP..SPECTRUM_BOTTOM)
            .max_by_key(|&y| brightness(pixel(&pixels, column, y)))
            .unwrap();
        let expected = SPECTRUM_TOP as f64 + frequency_row(1_000.0);
        assert!(
            (brightest as f64 - expected).abs() <= 2.0,
            "{brightest} vs {expected}"
        );
        // Far from it, only the window's leakage: near the floor.
        let bass = SPECTRUM_TOP + frequency_row(100.0) as usize;
        assert!(brightness(pixel(&pixels, column, bass)) < brightness(heat(0.3)));
    }

    #[test]
    fn silence_is_the_darkest_colour_throughout() {
        let pixels = picture(&vec![0.0; BAR_FRAMES]);
        for y in SPECTRUM_TOP..SPECTRUM_BOTTOM {
            for x in LEFT..LEFT + PLOT_WIDTH {
                let colour = pixel(&pixels, x, y);
                assert!(
                    colour == heat(0.0) || colour == GRID,
                    "{x}, {y}: {colour:?}"
                );
            }
        }
    }

    #[test]
    fn time_runs_left_to_right_across_the_range() {
        let mut samples = vec![0.0; BAR_FRAMES];
        samples.extend(sine(440.0, 0.5, RATE, BAR_FRAMES));
        let pixels = picture(&samples);
        let row = SPECTRUM_TOP + frequency_row(440.0).round() as usize;
        let loudness = |x: usize| brightness(pixel(&pixels, x, row));
        assert!(loudness(between_beats(0.25)) < brightness(heat(0.1)));
        assert!(loudness(between_beats(0.75)) > brightness(heat(0.8)));
    }

    #[test]
    fn the_waveform_is_red_only_where_it_clips() {
        let mut samples = sine(100.0, 0.5, RATE, BAR_FRAMES);
        samples.extend(sine(100.0, 1.5, RATE, BAR_FRAMES));
        let pixels = picture(&samples);
        let red_in = |columns: std::ops::Range<usize>| {
            columns.into_iter().any(|x| {
                (WAVE_TOP..WAVE_TOP + WAVE_HEIGHT).any(|y| pixel(&pixels, LEFT + x, y) == CLIPPED)
            })
        };
        assert!(!red_in(0..PLOT_WIDTH / 2 - 1));
        assert!(red_in(PLOT_WIDTH / 2 + 1..PLOT_WIDTH));
    }

    #[test]
    fn a_short_range_is_labelled_on_every_beat() {
        let labels = time_labels(&timeline(0.0), 4.0);
        let texts: Vec<&str> = labels.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(
            texts,
            ["1", "1.2", "1.3", "1.4", "2", "2.2", "2.3", "2.4", "3"]
        );
        assert_eq!(labels[0].x, 0);
        assert_eq!(labels[4].x, PLOT_WIDTH / 2);
    }

    #[test]
    fn a_long_range_is_labelled_every_few_bars_from_where_it_starts() {
        let bar = TimeSignature::default().bar_ticks() as f64;
        // 64 bars from the start of bar 3: every fourth bar, on bar lines.
        let labels = time_labels(&timeline(2.0 * bar), 128.0);
        let texts: Vec<&str> = labels.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts[..3], ["5", "9", "13"]);
        assert_eq!(texts.last(), Some(&"65"));
        assert!(
            labels
                .windows(2)
                .all(|w| (w[1].x - w[0].x) as f64 >= MIN_LABEL_GAP - 1.0)
        );
    }

    #[test]
    fn the_axes_are_labelled() {
        let pixels = picture(&vec![0.0; BAR_FRAMES]);
        let has_text = |xs: std::ops::Range<usize>, ys: std::ops::Range<usize>| {
            xs.into_iter()
                .any(|x| ys.clone().any(|y| pixel(&pixels, x, y) == TEXT))
        };
        // Bar numbers under the spectrogram, frequencies left of it, dB right.
        assert!(has_text(
            LEFT..LEFT + PLOT_WIDTH,
            SPECTRUM_BOTTOM + 6..HEIGHT
        ));
        let one_k = SPECTRUM_TOP + frequency_row(1_000.0) as usize;
        assert!(has_text(0..LEFT - 4, one_k - 5..one_k + 5));
        assert!(has_text(
            SCALE_LEFT + SCALE_WIDTH..WIDTH,
            SPECTRUM_TOP..SPECTRUM_BOTTOM
        ));
    }

    #[test]
    fn the_colour_map_gets_brighter_all_the_way() {
        let levels: Vec<u32> = (0..=100)
            .map(|i| brightness(heat(f64::from(i) / 100.0)))
            .collect();
        assert!(levels.windows(2).all(|w| w[0] <= w[1]), "{levels:?}");
        assert_eq!(heat(1.0), [252, 255, 164]);
    }

    #[test]
    fn base64_pads_to_whole_quads() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd, 0x00]), "//79AA==");
    }
}
