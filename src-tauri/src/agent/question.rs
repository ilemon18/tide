//! Structured questions embedded in ordinary assistant text.
//!
//! The protocol lives in the text stream so it works identically for every provider. Text before
//! and after a marker stays ordinary assistant text; only a complete, valid marker becomes a
//! question item. Invalid markers are restored verbatim and reported separately.

use serde::{Deserialize, Serialize};

pub const QUESTION_START: &str = "<TIDE_QUESTION>";
pub const QUESTION_END: &str = "</TIDE_QUESTION>";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub header: String,
    pub question: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

impl Question {
    fn is_valid(&self) -> bool {
        !self.header.trim().is_empty()
            && !self.question.trim().is_empty()
            && (2..=4).contains(&self.options.len())
            && self
                .options
                .iter()
                .all(|option| !option.label.trim().is_empty() && !option.description.trim().is_empty())
    }
}

/// Ordered pieces produced by the parser. `Invalid` contains the original marker text.
#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    Text(String),
    Question(Question),
    Invalid(String),
}

/// Streaming parser for `<TIDE_QUESTION>…</TIDE_QUESTION>` markers.
///
/// Ordinary text is emitted as soon as it cannot be a marker prefix. A partial marker is held
/// until the next delta. Only the first valid question in one turn is accepted; subsequent valid
/// markers are restored as text and reported by the translator.
#[derive(Default)]
pub struct Parser {
    buffer: String,
    accepted: bool,
}

impl Parser {
    pub fn push(&mut self, text: &str) -> Vec<Piece> {
        if text.is_empty() {
            return Vec::new();
        }
        self.buffer.push_str(text);
        self.drain()
    }

    /// Finish a text block or turn. An unclosed full marker is invalid; a partial marker prefix
    /// was never a marker and is restored as ordinary text.
    pub fn flush(&mut self) -> Vec<Piece> {
        if self.buffer.is_empty() {
            return Vec::new();
        }
        let text = std::mem::take(&mut self.buffer);
        if text.starts_with(QUESTION_START) {
            vec![Piece::Invalid(text)]
        } else {
            vec![Piece::Text(text)]
        }
    }

    fn drain(&mut self) -> Vec<Piece> {
        let mut out = Vec::new();
        loop {
            let Some(start) = self.buffer.find(QUESTION_START) else {
                let keep = partial_start_suffix(&self.buffer);
                let emit = self.buffer.len().saturating_sub(keep);
                if emit > 0 {
                    out.push(Piece::Text(self.buffer[..emit].to_string()));
                }
                if keep == 0 {
                    self.buffer.clear();
                } else {
                    self.buffer = self.buffer[emit..].to_string();
                }
                break;
            };

            if start > 0 {
                out.push(Piece::Text(self.buffer[..start].to_string()));
                self.buffer.drain(..start);
            }

            let after_start = &self.buffer[QUESTION_START.len()..];
            let Some(end) = after_start.find(QUESTION_END) else {
                break;
            };
            let raw_len = QUESTION_START.len() + end + QUESTION_END.len();
            let raw = self.buffer[..raw_len].to_string();
            let body = &self.buffer[QUESTION_START.len()..QUESTION_START.len() + end];
            match serde_json::from_str::<Question>(body) {
                Ok(question) if question.is_valid() && !self.accepted => {
                    self.accepted = true;
                    out.push(Piece::Question(question));
                }
                _ => out.push(Piece::Invalid(raw)),
            }
            self.buffer.drain(..raw_len);
        }
        out
    }
}

fn partial_start_suffix(text: &str) -> usize {
    let max = text.len().min(QUESTION_START.len() - 1);
    (1..=max)
        .rev()
        .find(|length| {
            text.is_char_boundary(text.len() - length)
                && text[text.len() - length..].ends_with(&QUESTION_START[..*length])
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question_json(id: &str) -> String {
        format!(
            r#"{{"header":"Decision {id}","question":"Pick one","multiSelect":false,"options":[{{"label":"A","description":"First"}},{{"label":"B","description":"Second"}}]}}"#
        )
    }

    fn marker(id: &str) -> String {
        format!("{QUESTION_START}{}{QUESTION_END}", question_json(id))
    }

    #[test]
    fn accepts_a_complete_question_and_preserves_surrounding_text() {
        let mut parser = Parser::default();
        let input = format!("before\n{}\nafter", marker("1"));
        assert_eq!(
            parser.push(&input),
            vec![
                Piece::Text("before\n".into()),
                Piece::Question(Question {
                    header: "Decision 1".into(),
                    question: "Pick one".into(),
                    multi_select: false,
                    options: vec![
                        QuestionOption {
                            label: "A".into(),
                            description: "First".into(),
                        },
                        QuestionOption {
                            label: "B".into(),
                            description: "Second".into(),
                        },
                    ],
                }),
                Piece::Text("\nafter".into()),
            ]
        );
    }

    #[test]
    fn accepts_a_marker_split_across_fragments() {
        let mut parser = Parser::default();
        let input = marker("1");
        let (a, b) = input.split_at(17);
        let (b, c) = b.split_at(39);
        assert!(parser.push(a).is_empty());
        assert!(matches!(parser.push(b).as_slice(), []));
        let pieces = parser.push(c);
        assert!(pieces
            .iter()
            .any(|piece| matches!(piece, Piece::Question(question) if question.header == "Decision 1")));
    }

    #[test]
    fn keeps_multiple_text_segments_in_order() {
        let mut parser = Parser::default();
        let input = format!("one{}two{}three", marker("1"), marker("2"));
        let pieces = parser.push(&input);
        assert!(matches!(pieces[0], Piece::Text(ref text) if text == "one"));
        assert!(matches!(pieces[1], Piece::Question(_)));
        assert!(matches!(pieces[2], Piece::Text(ref text) if text == "two"));
        assert!(matches!(pieces[3], Piece::Invalid(ref text) if text == &marker("2")));
        assert!(matches!(pieces[4], Piece::Text(ref text) if text == "three"));
    }

    #[test]
    fn restores_malformed_json_and_invalid_options() {
        let mut parser = Parser::default();
        let malformed = format!("{QUESTION_START}{{nope{QUESTION_END}");
        assert_eq!(parser.push(&malformed), vec![Piece::Invalid(malformed.clone())]);

        let invalid = format!(
            "{QUESTION_START}{{\"header\":\"H\",\"question\":\"Q\",\"multiSelect\":false,\"options\":[{{\"label\":\"A\",\"description\":\"\"}}]}}{QUESTION_END}"
        );
        assert_eq!(parser.push(&invalid), vec![Piece::Invalid(invalid)]);
    }

    #[test]
    fn unclosed_marker_is_invalid_at_flush() {
        let mut parser = Parser::default();
        let raw = format!("{QUESTION_START}{}", question_json("1"));
        assert!(parser.push(&raw).is_empty());
        assert_eq!(parser.flush(), vec![Piece::Invalid(raw)]);
    }

    #[test]
    fn partial_start_is_ordinary_text_at_flush() {
        let mut parser = Parser::default();
        assert_eq!(parser.push("hello <TIDE_QU"), vec![Piece::Text("hello ".into())]);
        assert_eq!(parser.flush(), vec![Piece::Text("<TIDE_QU".into())]);
    }
}
