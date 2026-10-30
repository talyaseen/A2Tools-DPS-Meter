# Choosing which players the meter shows

The meter's **Players shown** control selects **Everyone**, **Party / raid**, or
**Me**. New installs start with **Party / raid**, showing your own character and
the members identified by the game's group roster. The roster covers the group
reported by the game; there is no separate raid-membership detector.

Choose **Everyone** to include other players whose activity is present in the
captured game traffic, or **Me** to show only your character. The meter cannot
display damage the game never sends. While it has not identified your character
or group, a restricted view waits for that information instead of showing
everyone. An empty selected view says that it contains no players.

The choice is saved as `dpsMeter.audience`. An existing choice takes precedence.
When this setting is absent, the old `dpsMeter.onlyShowUser` value migrates from
`true` to **Me** and from `false` to **Everyone**. With neither setting, the
default is **Party / raid**.

The local meter, live Details, and enabled OBS overlay follow this selection.
Their totals and percentages describe the selected audience before the row cap.
For field bosses, **Everyone** still uses the existing **Others** estimate where
the game omits outside players' individual hits. Membership follows the game's
existing character/roster associations; matching character names across servers
can be ambiguous.

The choice does not change capture, the underlying fight data, saved history,
uploads, or plugin permissions. It does not control what another player's meter
can see.
