//! po-vt: host-side VT screen of a PTY, shared by the app and termd.
//!
//! Each PTY can have an emulated screen (alacritty_terminal) fed with the
//! SAME bytes that go to the renderer. `snapshot()` serializes grid,
//! scrollback, cursor and modes into an ANSI sequence that, written into a
//! fresh xterm of the same size, rebuilds the screen: no cut in the middle of
//! an escape sequence, correct alt-screen and modes, history in lines.
use std::fmt::Write as _;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor};

/// High bit of the replay endOffset header: "these bytes are a VT snapshot".
/// The renderer skips the resize bounce that only the raw replay needs
/// (the snapshot is already the exact screen). Real offsets never reach 2^63.
pub const VT_SNAPSHOT_FLAG: u64 = 1 << 63;

/// VT replay payload: [endOffset|flag u64 LE][cols u16 LE][rows u16 LE][snapshot].
/// The size is the host screen's (= PTY): the renderer opens the xterm at that
/// grid even without known dims (first attach after a launch).
pub fn vt_replay_payload(state: &mut TermState) -> Vec<u8> {
    let (cols, rows) = state.dims();
    let fed = state.fed();
    let snap = state.snapshot();
    let mut out = Vec::with_capacity(12 + snap.len());
    out.extend_from_slice(&(fed | VT_SNAPSHOT_FLAG).to_le_bytes());
    out.extend_from_slice(&cols.to_le_bytes());
    out.extend_from_slice(&rows.to_le_bytes());
    out.extend_from_slice(&snap);
    out
}

/// Scrollback lines kept by the host (= the renderer xterm's scrollback).
pub const HOST_SCROLLBACK: usize = 5000;

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TermState {
    term: Term<VoidListener>,
    parser: Processor,
    /// Bytes received since spawn: the snapshot's endOffset.
    fed: u64,
}

impl TermState {
    pub fn new(cols: u16, rows: u16) -> Self {
        let config = Config {
            scrolling_history: HOST_SCROLLBACK,
            ..Config::default()
        };
        let size = Size {
            cols: cols.max(2) as usize,
            rows: rows.max(1) as usize,
        };
        Self {
            term: Term::new(config, &size, VoidListener),
            parser: Processor::new(),
            fed: 0,
        }
    }

    /// PTY bytes, the same ones pushed into the replay buffer.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.fed += bytes.len() as u64;
    }

    pub fn fed(&self) -> u64 {
        self.fed
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let size = Size {
            cols: cols.max(2) as usize,
            rows: rows.max(1) as usize,
        };
        if size.cols == self.term.columns() && size.rows == self.term.screen_lines() {
            return;
        }
        self.term.resize(size);
    }

    pub fn dims(&self) -> (u16, u16) {
        (self.term.columns() as u16, self.term.screen_lines() as u16)
    }

    /// ANSI sequence that rebuilds the screen in a fresh xterm of the same size.
    pub fn snapshot(&mut self) -> Vec<u8> {
        // Synchronized frame (mode 2026, Claude Code uses one per redraw)
        // still held by the parser: its bytes are already in the endOffset and
        // the renderer will not get them from the live stream, so they go in the snapshot.
        if self.parser.sync_bytes_count() > 0 {
            self.parser.stop_sync(&mut self.term);
        }
        let grid = self.term.grid();
        let mode = *self.term.mode();
        let cols = grid.columns();
        let mut out = String::with_capacity(64 * 1024);
        let mut pen = Pen::default();

        if mode.contains(TermMode::ALT_SCREEN) {
            // The main screen is not accessible while the alternate one is
            // active: rebuild the alternate one, which is the visible one.
            out.push_str("\x1b[?1049h\x1b[H\x1b[2J");
        }

        let top = grid.topmost_line().0;
        let bottom = grid.bottommost_line().0;
        // Cells to emit per row: non-wrapped rows drop trailing blanks.
        let trimmed = |line: i32| -> usize {
            let row = &grid[Line(line)];
            let mut end = cols;
            while end > 0 && is_blank(&row[Column(end - 1)]) {
                end -= 1;
            }
            end
        };
        let mut after_wrap = false;
        for line in top..=bottom {
            let row = &grid[Line(line)];
            // The wrap is reproduced only if the next row prints at least one
            // character (that is what makes the xterm wrap). A TUI that erased
            // the continuation leaves WRAPLINE on a row followed by an empty
            // one: its "\r\n" would land back on the wrapped row and the
            // whole screen below would shift by one row.
            let wrapped = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE)
                && line != bottom
                && trimmed(line + 1) > 0;
            let end = if wrapped { cols } else { trimmed(line) };
            for col in 0..end {
                let cell = &row[Column(col)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                pen.apply(&mut out, cell);
                out.push(if cell.c == '\0' { ' ' } else { cell.c });
                if let Some(zw) = cell.zerowidth() {
                    out.extend(zw.iter());
                }
            }
            // Continuation row: the wrap scroll created it with the color of its
            // first character (BCE), so trailing blank cells are cleared by
            // hand. Never on a full row: with a pending wrap, EL would erase
            // the last character.
            if after_wrap && !wrapped && end < cols {
                pen.reset(&mut out);
                out.push_str("\x1b[0m\x1b[K");
            }
            after_wrap = wrapped;
            // Auto wrap: the next character makes the xterm wrap, so the row stays
            // "wrapped" there too (correct reflow).
            if line != bottom && !wrapped {
                pen.reset(&mut out);
                out.push_str("\r\n");
            }
        }
        pen.reset(&mut out);

        let cursor = grid.cursor.point;
        let _ = write!(out, "\x1b[{};{}H", cursor.line.0 + 1, cursor.column.0 + 1);
        push_modes(&mut out, mode);
        out.into_bytes()
    }
}

fn is_blank(cell: &Cell) -> bool {
    (cell.c == ' ' || cell.c == '\0')
        && cell.bg == Color::Named(NamedColor::Background)
        && !cell
            .flags
            .intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        && cell.hyperlink().is_none()
}

/// DEC modes the renderer must get back after the replay (the spawn preamble
/// resets them; a live TUI re-enabled them and expects them to stay).
fn push_modes(out: &mut String, mode: TermMode) {
    let set = |out: &mut String, on: bool, code: &str| {
        if on {
            let _ = write!(out, "\x1b[?{code}h");
        }
    };
    set(out, mode.contains(TermMode::APP_CURSOR), "1");
    set(out, mode.contains(TermMode::MOUSE_REPORT_CLICK), "1000");
    set(out, mode.contains(TermMode::MOUSE_DRAG), "1002");
    set(out, mode.contains(TermMode::MOUSE_MOTION), "1003");
    set(out, mode.contains(TermMode::FOCUS_IN_OUT), "1004");
    set(out, mode.contains(TermMode::SGR_MOUSE), "1006");
    set(out, mode.contains(TermMode::BRACKETED_PASTE), "2004");
    if mode.contains(TermMode::APP_KEYPAD) {
        out.push_str("\x1b=");
    }
    if !mode.contains(TermMode::LINE_WRAP) {
        out.push_str("\x1b[?7l");
    }
    if !mode.contains(TermMode::SHOW_CURSOR) {
        out.push_str("\x1b[?25l");
    }
}

/// Current output attributes: SGR is emitted only when they change.
#[derive(Default)]
struct Pen {
    sgr: Option<String>,
    link: Option<(String, String)>,
}

impl Pen {
    fn apply(&mut self, out: &mut String, cell: &Cell) {
        let sgr = sgr_of(cell);
        if self.sgr.as_deref() != Some(sgr.as_str()) {
            let _ = write!(out, "\x1b[{sgr}m");
            self.sgr = Some(sgr);
        }
        let link = cell
            .hyperlink()
            .map(|h| (h.id().to_string(), h.uri().to_string()));
        if link != self.link {
            match &link {
                Some((id, uri)) => {
                    let _ = write!(out, "\x1b]8;id={id};{uri}\x1b\\");
                }
                None => out.push_str("\x1b]8;;\x1b\\"),
            }
            self.link = link;
        }
    }

    fn reset(&mut self, out: &mut String) {
        if self.link.take().is_some() {
            out.push_str("\x1b]8;;\x1b\\");
        }
        if self.sgr.take().is_some_and(|s| s != "0") {
            out.push_str("\x1b[0m");
        }
    }
}

fn sgr_of(cell: &Cell) -> String {
    let mut s = String::from("0");
    let f = cell.flags;
    if f.contains(Flags::BOLD) {
        s.push_str(";1");
    }
    if f.contains(Flags::DIM) {
        s.push_str(";2");
    }
    if f.contains(Flags::ITALIC) {
        s.push_str(";3");
    }
    if f.contains(Flags::DOUBLE_UNDERLINE) {
        s.push_str(";4:2");
    } else if f.contains(Flags::UNDERCURL) {
        s.push_str(";4:3");
    } else if f.contains(Flags::DOTTED_UNDERLINE) {
        s.push_str(";4:4");
    } else if f.contains(Flags::DASHED_UNDERLINE) {
        s.push_str(";4:5");
    } else if f.contains(Flags::UNDERLINE) {
        s.push_str(";4");
    }
    if f.contains(Flags::INVERSE) {
        s.push_str(";7");
    }
    if f.contains(Flags::HIDDEN) {
        s.push_str(";8");
    }
    if f.contains(Flags::STRIKEOUT) {
        s.push_str(";9");
    }
    push_color(&mut s, cell.fg, 30, 90, 38);
    push_color(&mut s, cell.bg, 40, 100, 48);
    if let Some(ul) = cell.underline_color() {
        push_color(&mut s, ul, 0, 0, 58);
    }
    s
}

/// `base`/`bright` = SGR for the 16 colors (0 = extended form only, for 58).
fn push_color(s: &mut String, color: Color, base: u8, bright: u8, ext: u8) {
    match color {
        Color::Named(n) => {
            let idx = n as usize;
            let idx = match n {
                NamedColor::DimBlack
                | NamedColor::DimRed
                | NamedColor::DimGreen
                | NamedColor::DimYellow
                | NamedColor::DimBlue
                | NamedColor::DimMagenta
                | NamedColor::DimCyan
                | NamedColor::DimWhite => idx - NamedColor::DimBlack as usize,
                _ => idx,
            };
            if idx >= 16 {
                return; // Foreground/Background/Cursor…: default color
            }
            if base == 0 {
                let _ = write!(s, ";{ext}:5:{idx}");
            } else if idx < 8 {
                let _ = write!(s, ";{}", base as usize + idx);
            } else {
                let _ = write!(s, ";{}", bright as usize + idx - 8);
            }
        }
        Color::Indexed(i) => {
            let _ = write!(s, ";{ext};5;{i}");
        }
        Color::Spec(rgb) => {
            let _ = write!(s, ";{ext};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Text + attributes of every row (history + screen) and cursor/modes.
    fn dump(t: &TermState) -> (Vec<String>, (i32, usize), TermMode) {
        let grid = t.term.grid();
        let mut rows = Vec::new();
        for line in grid.topmost_line().0..=grid.bottommost_line().0 {
            let row = &grid[Line(line)];
            let mut s = String::new();
            for col in 0..grid.columns() {
                let c = &row[Column(col)];
                let _ = write!(s, "{}{}|", c.c, visible_sgr(c));
            }
            rows.push(s);
        }
        let p = grid.cursor.point;
        (rows, (p.line.0, p.column.0), *t.term.mode())
    }

    /// Visible SGR: on a blank space only the background and drawing attributes count.
    pub(super) fn visible_sgr(c: &Cell) -> String {
        if (c.c == ' ' || c.c == '\0') && is_blank(c) {
            return "0".into();
        }
        sgr_of(c)
    }

    fn round_trip(cols: u16, rows: u16, input: &[u8]) {
        let mut a = TermState::new(cols, rows);
        a.feed(input);
        let mut b = TermState::new(cols, rows);
        let snap = a.snapshot();
        b.feed(&snap);
        let (ra, ca, ma) = dump(&a);
        let (rb, cb, mb) = dump(&b);
        // B's history may have fewer leading empty rows: compare from the bottom.
        let n = ra.len().min(rb.len());
        assert_eq!(ra[ra.len() - n..], rb[rb.len() - n..], "grid differs");
        assert_eq!(ca, cb, "cursor differs");
        let keep = TermMode::APP_CURSOR
            | TermMode::BRACKETED_PASTE
            | TermMode::SGR_MOUSE
            | TermMode::MOUSE_REPORT_CLICK
            | TermMode::FOCUS_IN_OUT
            | TermMode::ALT_SCREEN
            | TermMode::SHOW_CURSOR
            | TermMode::LINE_WRAP;
        assert_eq!(ma & keep, mb & keep, "modes differ");
    }

    #[test]
    fn plain_lines_and_scrollback() {
        let mut s = Vec::new();
        for i in 0..200 {
            s.extend_from_slice(format!("line {i}\r\n").as_bytes());
        }
        s.extend_from_slice(b"$ ");
        round_trip(40, 10, &s);
    }

    #[test]
    fn colors_attributes_and_cursor() {
        round_trip(
            30,
            6,
            b"\x1b[1;31mred\x1b[0m \x1b[38;5;208morange\x1b[0m\r\n\x1b[48;2;10;20;30m rgb \x1b[0m\x1b[4mul\x1b[0m\r\n\x1b[7minv\x1b[0m\x1b[3;5H",
        );
    }

    #[test]
    fn wrapped_line_stays_wrapped() {
        round_trip(10, 4, b"0123456789abcdefghij-xyz\r\nok");
    }

    #[test]
    fn wide_chars_and_utf8() {
        round_trip(10, 4, "日本語テスト ok\r\nñé€".as_bytes());
    }

    #[test]
    fn alt_screen_and_modes() {
        round_trip(
            20,
            5,
            b"shell\r\n\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[2;3HTUI\x1b[5;1Hbar",
        );
    }

    #[test]
    fn utf8_split_across_feeds() {
        let bytes = "€uro".as_bytes();
        let mut a = TermState::new(10, 2);
        a.feed(&bytes[..1]);
        a.feed(&bytes[1..]);
        let mut b = TermState::new(10, 2);
        b.feed(bytes);
        assert_eq!(dump(&a).0, dump(&b).0);
    }

    #[test]
    fn resize_keeps_content() {
        let mut a = TermState::new(20, 5);
        a.feed(b"hello\r\nworld");
        a.resize(30, 8);
        assert_eq!(a.dims(), (30, 8));
        let snap = String::from_utf8(a.snapshot()).unwrap();
        assert!(snap.contains("hello") && snap.contains("world"));
    }
}

/// Round-trip on real parked buffers (actual Claude/Codex output):
/// `PROMPTOPS_PARKED_DIR=… cargo test --lib term_state_real -- --ignored --nocapture`.
#[cfg(test)]
mod real_buffers {
    use super::*;

    #[test]
    #[ignore]
    fn term_state_real_round_trip() {
        let Ok(dir) = std::env::var("PROMPTOPS_PARKED_DIR") else {
            return;
        };
        let (mut ok, mut bad) = (0, 0);
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let bytes = std::fs::read(entry.path()).unwrap();
            for (cols, rows) in [(120u16, 30u16), (80, 24)] {
                let mut a = TermState::new(cols, rows);
                a.feed(&bytes);
                let mut b = TermState::new(cols, rows);
                b.feed(&a.snapshot());
                let ga = a.term.grid();
                let gb = b.term.grid();
                let text = |g: &alacritty_terminal::Grid<Cell>, l: i32| -> String {
                    (0..g.columns())
                        .map(|c| {
                            format!(
                                "{}{}",
                                g[Line(l)][Column(c)].c,
                                super::tests::visible_sgr(&g[Line(l)][Column(c)])
                            )
                        })
                        .collect()
                };
                // Compare visible screen + cursor (leading history may differ by empty rows).
                let mut same = ga.cursor.point == gb.cursor.point;
                let mut first_diff = None;
                for l in 0..rows as i32 {
                    if text(ga, l) != text(gb, l) {
                        same = false;
                        if first_diff.is_none() && std::env::var("PROMPTOPS_DIFF_DETAIL").is_ok() {
                            let (ta, tb) = (text(ga, l), text(gb, l));
                            let ca: Vec<char> = ta.chars().collect();
                            let cb: Vec<char> = tb.chars().collect();
                            let i = ca
                                .iter()
                                .zip(cb.iter())
                                .position(|(x, y)| x != y)
                                .unwrap_or(0);
                            let lo = i.saturating_sub(30);
                            eprintln!(
                                "  A: {:?}\n  B: {:?}",
                                ca[lo..(i + 60).min(ca.len())].iter().collect::<String>(),
                                cb[lo..(i + 60).min(cb.len())].iter().collect::<String>()
                            );
                        }
                        first_diff.get_or_insert(l);
                    }
                }
                if !same && std::env::var("PROMPTOPS_DIFF_DETAIL").is_ok() {
                    let plain = |g: &alacritty_terminal::Grid<Cell>, l: i32| -> String {
                        let wrap = if g[Line(l)][Column(g.columns() - 1)]
                            .flags
                            .contains(Flags::WRAPLINE)
                        {
                            "↩"
                        } else {
                            ""
                        };
                        format!(
                            "{}{wrap}",
                            (0..g.columns())
                                .map(|c| g[Line(l)][Column(c)].c)
                                .collect::<String>()
                                .trim_end()
                        )
                    };
                    for l in 0..rows as i32 {
                        if text(ga, l) != text(gb, l) && plain(ga, l) != plain(gb, l) {
                            eprintln!(
                                "  line {l}\n   A[-1] {:?}\n   A     {:?}\n   B     {:?}",
                                plain(ga, l - 1),
                                plain(ga, l),
                                plain(gb, l)
                            );
                        }
                    }
                }
                if same {
                    ok += 1;
                } else {
                    bad += 1;
                    eprintln!(
                        "DIFF {:?} {cols}x{rows} line {:?} cursor {:?} vs {:?}",
                        entry.file_name(),
                        first_diff,
                        ga.cursor.point,
                        gb.cursor.point
                    );
                }
            }
        }
        eprintln!("real round-trip: ok={ok} diff={bad}");
        assert_eq!(bad, 0);
    }
}

#[cfg(test)]
mod wrap_regressions {
    use super::*;

    /// Wrapped row whose continuation was erased by the TUI (real Claude Code case).
    #[test]
    fn wrapped_row_followed_by_erased_row() {
        let mut a = TermState::new(10, 4);
        a.feed(b"0123456789abc\x1b[2;1H\x1b[2K\x1b[3;1Hnext");
        let mut b = TermState::new(10, 4);
        b.feed(&a.snapshot());
        for l in 0..4 {
            let row = |t: &TermState| {
                (0..10)
                    .map(|c| t.term.grid()[Line(l)][Column(c)].c)
                    .collect::<String>()
            };
            assert_eq!(row(&a), row(&b), "line {l}");
        }
        assert_eq!(a.term.grid().cursor.point, b.term.grid().cursor.point);
    }
}

#[cfg(test)]
mod bce_regressions {
    use super::*;

    /// Wrap with a colored background spanning both rows (real case: highlighted links).
    #[test]
    fn wrap_scroll_does_not_leak_background() {
        let mut a = TermState::new(10, 3);
        a.feed(b"x\r\ny\r\n\x1b[44m0123456789ab\x1b[0m");
        let mut b = TermState::new(10, 3);
        b.feed(&a.snapshot());
        for l in 0..3 {
            for c in 0..10 {
                assert_eq!(
                    a.term.grid()[Line(l)][Column(c)].bg,
                    b.term.grid()[Line(l)][Column(c)].bg,
                    "line {l} col {c}"
                );
            }
        }
    }
}

#[cfg(test)]
mod perf {
    use super::*;

    /// `PROMPTOPS_PARKED_DIR=… cargo test --release --lib term_state_perf -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn term_state_perf() {
        let Ok(dir) = std::env::var("PROMPTOPS_PARKED_DIR") else {
            return;
        };
        let (mut bytes, mut feed, mut snap, mut snap_max, mut out) =
            (0usize, 0u128, 0u128, 0u128, 0usize);
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let data = std::fs::read(entry.path()).unwrap();
            let mut t = TermState::new(120, 30);
            let t0 = std::time::Instant::now();
            t.feed(&data);
            feed += t0.elapsed().as_micros();
            let t1 = std::time::Instant::now();
            let s = t.snapshot();
            let e = t1.elapsed().as_micros();
            snap += e;
            snap_max = snap_max.max(e);
            bytes += data.len();
            out += s.len();
            eprintln!(
                "hist {} lines from {} KB",
                t.term.grid().history_size(),
                data.len() / 1024
            );
        }
        eprintln!(
            "input {} KB, feed {} ms ({:.0} MB/s), snapshot tot {} ms max {} ms, snapshot {} KB",
            bytes / 1024,
            feed / 1000,
            bytes as f64 / feed as f64,
            snap / 1000,
            snap_max / 1000,
            out / 1024
        );
    }
}

#[cfg(test)]
mod sync_regressions {
    use super::*;

    /// Snapshot taken in the middle of a synchronized frame: the frame must be included.
    #[test]
    fn pending_synchronized_frame_is_in_snapshot() {
        let mut a = TermState::new(20, 3);
        a.feed(b"\x1b[?2026hframe-in-progress");
        let snap = String::from_utf8(a.snapshot()).unwrap();
        assert!(snap.contains("frame-in-progress"));
    }
}

/// Exports snapshots of real buffers for comparison with headless xterm.js:
/// `PROMPTOPS_PARKED_DIR=… PROMPTOPS_SNAP_OUT=… cargo test --lib term_state_export -- --ignored`.
#[cfg(test)]
mod export {
    use super::*;

    #[test]
    #[ignore]
    fn term_state_export() {
        let (Ok(dir), Ok(out)) = (
            std::env::var("PROMPTOPS_PARKED_DIR"),
            std::env::var("PROMPTOPS_SNAP_OUT"),
        ) else {
            return;
        };
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let data = std::fs::read(entry.path()).unwrap();
            let mut t = TermState::new(120, 30);
            t.feed(&data);
            let name = entry.file_name().to_string_lossy().replace(".dat", ".snap");
            std::fs::write(std::path::Path::new(&out).join(name), t.snapshot()).unwrap();
        }
    }
}

#[cfg(test)]
mod payload {
    use super::*;

    #[test]
    fn vt_payload_header_carries_flag_offset_and_dims() {
        let mut t = TermState::new(100, 40);
        t.feed(b"hiya");
        let p = vt_replay_payload(&mut t);
        let head = u64::from_le_bytes(p[..8].try_into().unwrap());
        assert_eq!(head & VT_SNAPSHOT_FLAG, VT_SNAPSHOT_FLAG);
        assert_eq!(head & !VT_SNAPSHOT_FLAG, 4);
        assert_eq!(u16::from_le_bytes([p[8], p[9]]), 100);
        assert_eq!(u16::from_le_bytes([p[10], p[11]]), 40);
        assert!(String::from_utf8_lossy(&p[12..]).contains("hiya"));
    }
}
