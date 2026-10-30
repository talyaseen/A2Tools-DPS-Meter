use serde::{Deserialize, Serialize};

use crate::entity::special_damage::SpecialDamage;

/// How a player met the monsters' hits they took, from each hit's flags (the
/// game's damage plotter), for a tank's or a shield class's rates (Megashield,
/// 2026-10-22). A Perfect Block (0x40) comes with the Shield Block or Parry it
/// perfected: counted here as a perfect block or a perfect parry, and in its
/// shield block or parry too.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedHits {
    #[serde(default)]
    pub shield_block: i32,
    #[serde(default)]
    pub perfect_block: i32,
    #[serde(default)]
    pub parry: i32,
    #[serde(default)]
    pub perfect_parry: i32,
    #[serde(default)]
    pub iron_wall: i32,
}

impl ReceivedHits {
    /// One hit taken, by its flags.
    pub fn note(&mut self, specials: &[SpecialDamage]) {
        let has = |s: SpecialDamage| specials.contains(&s);
        let perfect = has(SpecialDamage::PerfectBlock);
        if has(SpecialDamage::ShieldBlock) {
            self.shield_block += 1;
            self.perfect_block += i32::from(perfect);
        }
        if has(SpecialDamage::Parry) {
            self.parry += 1;
            self.perfect_parry += i32::from(perfect);
        }
        self.iron_wall += i32::from(has(SpecialDamage::IronWall));
    }

    pub fn add(&mut self, other: ReceivedHits) {
        self.shield_block += other.shield_block;
        self.perfect_block += other.perfect_block;
        self.parry += other.parry;
        self.perfect_parry += other.perfect_parry;
        self.iron_wall += other.iron_wall;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsActorSummary {
    pub actor_id: i32,
    pub nickname: String,
    #[serde(default)]
    pub job: String,
    /// Job class prefix ID (e.g. 11=Gladiator) for language-independent storage
    #[serde(default)]
    pub job_id: i32,
    #[serde(default)]
    pub party_heal: i64,
    #[serde(default)]
    pub regen: i64,
    #[serde(default)]
    pub damage_received: i64,
    #[serde(default)]
    pub hits_received: i32,
    /// How those hits were met. None in fights recorded before the meter
    /// counted it (2.0.76), so "none blocked" isn't claimed for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received: Option<ReceivedHits>,
    /// Roster id for this actor, or 0 when the party roster never named them
    /// (solo play, or a player who joined before the roster packet arrived).
    ///
    /// Local-only. It is deliberately *not* what goes on the wire when a fight
    /// is shared: uploads carry `sha256(dbid)` so the server can tell two rows
    /// apart without learning who they are. See `docs/PRIVACY.md`.
    #[serde(default)]
    pub dbid: u64,
    /// World/server id, the top 16 bits of `dbid`. 0 when unknown.
    #[serde(default)]
    pub server_id: u16,
    /// Renders this name gold in the Details party bars. See
    /// `crate::supporters`; cosmetic only.
    #[serde(default)]
    pub is_supporter: bool,
    /// Character level, gear score and combat power from the party roster, as
    /// the game reported them for this fight. 0 when the roster never named
    /// the actor: only your own party's members are on it.
    ///
    /// Saved with the fight because they change: a gear score from today says
    /// nothing about a fight from last month, and the class statistics compare
    /// players at like strength.
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub gear_score: i32,
    #[serde(default)]
    pub combat_power: i64,
    /// Live display metadata. False is omitted so saved fights keep their shape.
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_party_member: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_local_player: bool,
}

fn is_false(value: &bool) -> bool { !value }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsTargetSummary {
    pub target_id: i32,
    #[serde(default)]
    pub target_name: String,
    #[serde(default)]
    pub max_hp: i32,
    pub battle_time: i64,
    pub last_damage_time: i64,
    pub total_damage: i32,
    pub actor_damage: std::collections::HashMap<i32, i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsContext {
    pub current_target_id: i32,
    pub targets: Vec<DetailsTargetSummary>,
    pub actors: Vec<DetailsActorSummary>,
    #[serde(default)]
    pub audience_known: bool,
    #[serde(default)]
    pub party_generation: u64,
    #[serde(default)]
    pub local_player_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSkillEntry {
    pub actor_id: i32,
    pub code: i32,
    pub name: String,
    pub time: i32,
    pub dmg: i32,
    pub multi_hit_count: i32,
    pub multi_hit_damage: i32,
    #[serde(default)]
    pub multi_hit_hits: i32,
    #[serde(default)]
    pub min_dmg: i32,
    #[serde(default)]
    pub max_dmg: i32,
    pub crit: i32,
    #[serde(default)]
    pub shield_block: i32,
    pub parry: i32,
    pub back: i32,
    #[serde(default)]
    pub frontal: i32,
    pub perfect: i32,
    pub double: i32,
    #[serde(default)]
    pub iron_wall: i32,
    // Saved fights before the flags were renamed have the old names.
    #[serde(default, alias = "smite")]
    pub regeneration: i32,
    #[serde(default, alias = "powershard")]
    pub perfect_block: i32,
    #[serde(default)]
    pub miss: i32,
    #[serde(default)]
    pub resist: i32,
    pub regen: i32,
    #[serde(default)]
    pub job: String,
    #[serde(default)]
    pub is_dot: bool,
    #[serde(default)]
    pub hit_timestamps: Vec<i64>,
    #[serde(default)]
    pub specs: Vec<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingPoint {
    pub ts_ms: i64,
    pub ping_ms: i32,
}

/// A player dying during a fight, ms from its first hit (Details marks it on
/// the DPS chart).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeathPoint {
    pub actor_id: i32,
    pub ts_ms: i64,
    /// When they were back up, ms from the fight's first hit; none if they
    /// stayed down to the end. The chart greys their line in between.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revived_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDetailsResponse {
    pub target_id: i32,
    #[serde(default)]
    pub max_hp: i32,
    pub total_target_damage: i32,
    pub battle_time: i64,
    #[serde(default)]
    pub start_time: i64,
    pub skills: Vec<DetailSkillEntry>,
    #[serde(default)]
    pub ping_history: Vec<PingPoint>,
    /// Per-actor / per-skill HEALING done in this fight. Reuses DetailSkillEntry:
    /// `dmg` = heal amount, `time` = tick count, `is_dot` = HoT. Empty for old files.
    #[serde(default)]
    pub heal_skills: Vec<DetailSkillEntry>,
    /// The players who died in this fight, and when. None where not known:
    /// a fight saved before deaths were (Details shows "-"), or a summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deaths: Option<Vec<DeathPoint>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_skill_row_saved_before_the_flag_rename_reads_under_the_new_names() {
        let old = r#"{"actorId":1,"code":2,"name":"x","time":3,"dmg":4,"multiHitCount":0,"multiHitDamage":0,
            "crit":0,"parry":1,"back":0,"perfect":0,"double":0,"smite":5,"powershard":6,"regen":0}"#;
        let row: DetailSkillEntry = serde_json::from_str(old).unwrap();
        assert_eq!((row.parry, row.regeneration, row.perfect_block, row.shield_block, row.miss), (1, 5, 6, 0, 0));
        let json = serde_json::to_string(&row).unwrap();
        assert!(json.contains(r#""regeneration":5"#) && json.contains(r#""perfectBlock":6"#) && !json.contains("smite"));
    }
}

#[cfg(test)]
mod received_tests {
    use super::ReceivedHits;
    use crate::entity::special_damage::from_hit_flags;

    /// The flags of hits taken, as the game sends them (stream_processor's
    /// `hit_flags_of_received_hits`): a perfect block counts with what it
    /// perfected.
    #[test]
    fn hits_taken_are_counted_by_how_they_were_met() {
        let mut r = ReceivedHits::default();
        for flags in [0x01, 0x41, 0x02, 0x42, 0x10, 0x00, 0x20] {
            r.note(&from_hit_flags(flags));
        }
        assert_eq!(r, ReceivedHits { shield_block: 2, perfect_block: 1, parry: 2, perfect_parry: 1, iron_wall: 1 });
    }

    /// A record from before the meter counted them keeps no counts, rather
    /// than counts of 0.
    #[test]
    fn older_records_have_none() {
        let old: super::DetailsActorSummary = serde_json::from_str(r#"{"actorId":1,"nickname":"A","damageReceived":5,"hitsReceived":2}"#).unwrap();
        assert_eq!(old.received, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("received\":"));
    }
}
