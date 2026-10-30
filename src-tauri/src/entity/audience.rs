/// A display preference. Capture, saved fights and upload derivation always
/// keep their original participant set and numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Audience {
    Everyone,
    #[default]
    Party,
    SelfOnly,
}

impl Audience {
    pub fn from_settings(get: impl Fn(&str) -> Option<String>) -> Self {
        match get("dpsMeter.audience").as_deref() {
            Some("everyone") => Self::Everyone,
            Some("party") => Self::Party,
            Some("self") => Self::SelfOnly,
            // Preserve a player's explicit older self/all choice. A missing
            // or malformed value does not opt into a broader audience.
            None => match get("dpsMeter.onlyShowUser").as_deref() {
                Some("true") => Self::SelfOnly,
                Some("false") => Self::Everyone,
                _ => Self::Party,
            },
            _ => Self::Party,
        }
    }

    pub fn allows(self, is_local: bool, is_party: bool, is_others: bool) -> bool {
        match self {
            Self::Everyone => true,
            Self::Party => !is_others && (is_local || is_party),
            Self::SelfOnly => !is_others && is_local,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_preferences_and_explicit_legacy_choices_have_predictable_audiences() {
        let choice = |audience: Option<&str>, old: Option<&str>| Audience::from_settings(|key| {
            match key { "dpsMeter.audience" => audience, "dpsMeter.onlyShowUser" => old, _ => None }.map(str::to_string)
        });
        assert_eq!(choice(None, None), Audience::Party);
        assert_eq!(choice(None, Some("true")), Audience::SelfOnly);
        assert_eq!(choice(None, Some("false")), Audience::Everyone);
        assert_eq!(choice(Some("party"), Some("false")), Audience::Party);
        assert_eq!(choice(Some("everyone"), Some("true")), Audience::Everyone);
        assert_eq!(choice(Some("unknown"), Some("false")), Audience::Party);
        assert!(!Audience::Party.allows(false, false, false));
        assert!(!Audience::Party.allows(false, false, true));
        assert!(Audience::Everyone.allows(false, false, true));
        assert!(Audience::Party.allows(true, false, false));
        assert!(!Audience::SelfOnly.allows(false, true, false));
    }
}
