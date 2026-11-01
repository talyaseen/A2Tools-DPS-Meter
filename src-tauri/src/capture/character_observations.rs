//! Bounded, local-capture observations. Unknown fields never become zero or
//! inherit a configured/loot-voted identity. No raw packet bytes leave here.
use serde_json::{json, Value};

#[derive(Default)]
pub struct Observations {
    session: Option<u64>,
    revision: u64,
    character: Option<(i32, String, u16)>,
    observed_at: Option<i64>,
    last_packet_at: Option<i64>,
    levels: Option<[u32; 5]>,
    reason: Option<&'static str>,
}

impl Observations {
    pub fn packet(&mut self, session: u64, now: i64) {
        if self.session != Some(session) {
            self.clear("Waiting for this capture stream's authoritative self profile.");
            self.session = Some(session);
        }
        self.last_packet_at = Some(now);
    }

    pub fn clear(&mut self, reason: &'static str) {
        self.revision = self.revision.wrapping_add(1);
        self.session = None;
        self.character = None;
        self.observed_at = None;
        self.last_packet_at = None;
        self.levels = None;
        self.reason = Some(reason);
    }

    pub fn profile(&mut self, session: u64, character: (i32, String, u16), levels: Option<[u32; 5]>, now: i64) {
        self.packet(session, now);
        if self.character.as_ref() != Some(&character) {
            self.revision = self.revision.wrapping_add(1);
        }
        self.character = Some(character);
        self.observed_at = Some(now);
        self.levels = levels;
        self.reason = levels.is_none().then_some("The latest self profile has an unsupported proficiency layout.");
    }

    pub fn identity(&mut self, session: u64, character: (i32, String, u16), now: i64) {
        if self.session != Some(session) || self.character.as_ref() != Some(&character) {
            self.profile(session, character, None, now);
        }
    }

    /// A recognized leading self packet may no longer match the supported
    /// layout. Drop its old levels without accepting the rejected identity
    /// or advancing the last accepted profile's timestamp.
    pub fn invalidate_proficiency(&mut self) {
        self.levels = None;
        self.reason = Some("The latest leading self profile could not be validated.");
    }

    pub fn snapshot(&self, now: i64) -> Value {
        let stale = self.last_packet_at.is_none_or(|at| now < at || now.saturating_sub(at) > 30_000);
        let character = self.character.as_ref().map(|(entity, name, server)| json!({
            "entityId": entity, "name": name, "serverId": server,
            "identityBasis": "self-profile", "identityVerified": true
        }));
        let skills: Vec<Value> = self.levels.map(|levels| levels.iter().enumerate().map(|(i, level)|
            json!({"id": i + 1, "level": level, "verified": true})).collect()).unwrap_or_default();
        let common = self.levels.and_then(|levels| levels.iter().all(|v| *v == levels[0]).then_some(levels[0]));
        json!({
            "schema": "a2-character-observation/v1", "source": "local-capture",
            "captureOrigin": "locked-server-to-client",
            "status": if stale {"stale"} else if character.is_some() {"ready"} else {"waiting"},
            "sessionRevision": self.revision, "character": character,
            "observedAt": self.observed_at, "stale": stale,
            "proficiency": {"status": if self.levels.is_some() {"verified"} else {"unknown"},
                "complete": self.levels.is_some(), "observedAt": self.observed_at,
                "commonLevel": common, "commonLevelBasis": common.map(|_| "all-five-self-profile-slots-equal"), "professionMapping": "unverified", "skills": skills,
                "reason": self.reason, "decoder": "self-profile-crafting-v1"},
            "inventory": {"status": "unknown", "complete": false, "items": [],
                "reason": "Inventory record ownership, container meanings and complete mutation coverage are not verified."},
            "wallet": {"status": "unknown", "value": null,
                "reason": "No verified wallet packet decoder is available. Kinah gained today is not a wallet balance."}
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_levels_to_authoritative_identity_and_capture_session() {
        let mut state = Observations::default();
        state.profile(1, (123, "Alice".into(), 1304), Some([100; 5]), 1_000);
        let value = state.snapshot(1_001);
        assert_eq!(value["character"]["name"], "Alice");
        assert_eq!(value["proficiency"]["commonLevel"], 100);
        assert_eq!(value["wallet"]["value"], Value::Null);
        state.packet(2, 2_000);
        let value = state.snapshot(2_001);
        assert_eq!(value["character"], Value::Null);
        assert_eq!(value["proficiency"]["skills"], json!([]));
        assert_eq!(value["status"], "waiting");
    }

    #[test]
    fn unsupported_profile_replaces_levels_and_quiet_capture_is_stale() {
        let mut state = Observations::default();
        state.profile(1, (123, "Alice".into(), 1304), Some([100; 5]), 1_000);
        state.profile(1, (456, "Bob".into(), 1304), None, 2_000);
        assert_eq!(state.snapshot(2_001)["proficiency"]["status"], "unknown");
        assert_eq!(state.snapshot(32_001)["status"], "stale");
        state.clear("Capture lost bytes.");
        assert_eq!(state.snapshot(32_002)["character"], Value::Null);
    }
}
