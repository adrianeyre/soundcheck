//! A 3×5 pixel font for the spectrogram's axis labels: just the characters
//! the labels use, so the picture needs no font file or text renderer.

/// Pixels across and down one glyph, before scaling.
pub const WIDTH: usize = 3;
pub const HEIGHT: usize = 5;

/// The glyph for `c`, one row of three bits per line, the leftmost pixel
/// the highest bit. Characters the labels never use are blank.
pub fn glyph(c: char) -> [u8; HEIGHT] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b011, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '.' => [0b000, 0b000, 0b000, 0b000, 0b010],
        '-' => [0b000, 0b000, 0b111, 0b000, 0b000],
        'B' => [0b110, 0b101, 0b110, 0b101, 0b110],
        'H' => [0b101, 0b101, 0b111, 0b101, 0b101],
        'a' => [0b000, 0b011, 0b101, 0b101, 0b011],
        'b' => [0b100, 0b100, 0b110, 0b101, 0b110],
        'd' => [0b001, 0b001, 0b011, 0b101, 0b011],
        'e' => [0b000, 0b111, 0b101, 0b110, 0b011],
        'k' => [0b100, 0b101, 0b110, 0b110, 0b101],
        'r' => [0b000, 0b110, 0b101, 0b100, 0b100],
        'v' => [0b000, 0b101, 0b101, 0b101, 0b010],
        'w' => [0b000, 0b101, 0b101, 0b111, 0b111],
        'z' => [0b000, 0b111, 0b001, 0b110, 0b111],
        _ => [0; HEIGHT],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_label_character_has_a_glyph() {
        for c in "0123456789.-BHabdekrvwz".chars() {
            assert_ne!(glyph(c), [0; HEIGHT], "{c}");
            assert!(glyph(c).iter().all(|&row| row < 1 << WIDTH), "{c}");
        }
        assert_eq!(glyph(' '), [0; HEIGHT]);
    }
}
