use serde::{Deserialize, Serialize};

/// Document categories — must match the backend Zod enum
/// (src/app-api/app-documents.controller.ts) exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Mietvertrag,
    Jobcenter,
    Bank,
    Visa,
    Versicherung,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Importance {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fact {
    pub content: String,
    pub importance: Importance,
}

/// `YYYY-MM-DD` — validated by the backend regex, produced by the local model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsoDate(pub String);

/// Structured extraction produced by the LOCAL model (llama.cpp, Phase 3).
/// Serialized and POSTed to `/app/v1/documents` — this is everything the
/// server ever sees of a document. The raw file stays on the device.
///
/// Field names MUST be camelCase on the wire: the backend Zod schema keyed
/// exactly on these names (src/app-api/app-documents.controller.ts) and the
/// LLGuidance JSON schema is kept in the same shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extraction {
    /// sha256 hex of the raw file bytes (dedup key on both sides).
    pub source_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    pub category: Category,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_date: Option<IsoDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub facts: Vec<Fact>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub deadlines: Vec<Deadline>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub obligations: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub addresses: Vec<Address>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub amounts: Vec<Amount>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<String>,
    pub is_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiry_date: Option<IsoDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Deadline {
    pub label: String,
    /// `YYYY-MM-DD`
    pub date: IsoDate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Address {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Amount {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

impl Extraction {
    /// Wire body for `POST /app/v1/documents`.
    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_category_lowercase_matching_backend_zod_enum() {
        let json = serde_json::to_string(&Category::Jobcenter).unwrap();
        assert_eq!(json, "\"jobcenter\"");
    }

    #[test]
    fn roundtrips_extraction_json() {
        let extraction = Extraction {
            source_hash: "a".repeat(64),
            file_name: Some("bescheid.pdf".into()),
            title: Some("Bewilligungsbescheid".into()),
            sender: Some("Jobcenter Berlin".into()),
            category: Category::Jobcenter,
            doc_date: Some(IsoDate("2026-08-01".into())),
            summary: None,
            facts: vec![Fact {
                content: "Bewilligung ab 01.10.2026".into(),
                importance: Importance::High,
            }],
            deadlines: vec![Deadline {
                label: "Widerspruch".into(),
                date: IsoDate("2026-09-01".into()),
                kind: Some("Widerspruchsfrist".into()),
            }],
            obligations: vec!["Nachweis einreichen".into()],
            addresses: vec![],
            amounts: vec![],
            tags: vec!["Bürgergeld".into()],
            is_active: true,
            expiry_date: None,
        };

        let json = extraction.to_json().unwrap();
        let parsed: Extraction = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.category, Category::Jobcenter);
        assert_eq!(parsed.deadlines.len(), 1);
        assert!(json.contains("\"isActive\""));
        // The wire contract is camelCase (backend Zod keys) — snake_case
        // variants would be rejected server-side.
        assert!(!json.contains("source_hash"));
        assert!(json.contains("\"sourceHash\""));
        assert!(!json.contains("\"is_active\""));
        // Optional empty fields are omitted on the wire
        assert!(!json.contains("\"summary\""));
        assert!(!json.contains("\"amounts\""));
        // but required arrays are always present
        assert!(json.contains("\"facts\""));
    }
}
