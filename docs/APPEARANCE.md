# Appearance preferences

Appearance settings synchronize through the existing per-account Matrix account
data. Global preference styles load with the application before Settings opens.
Interface density changes navigation and settings spacing independently of
chat text size. Compact navigation retains a 44-pixel minimum target on devices
with a coarse pointer.

Message spacing has compact, comfortable and spacious choices. The default,
**Follow Compact messages**, preserves the existing compact preference and
existing deployments' spacing. Choosing explicit spacing changes only the
vertical space around messages; the compact avatar treatment and chat font scale
remain separate. The settings preview shows the selected spacing.

Settings writes merge the latest server preferences and serialize per Matrix
client. Each read, write and acknowledgement checks the exact client, user,
device and managed-account generation. A late save cannot apply its appearance
or error rollback to a replacement account. Matrix account data does not provide
cross-device compare-and-swap; simultaneous updates from different devices still
have the server's normal last-write behavior.

Eight semantic checks cover normalization, merging and delayed account changes.
Eighteen browser checks exercise real settings controls, startup, persistence, independent
spacing, touch targets, delayed save success/failure, and modal layouts at narrow
and short viewport sizes. These checks do not replace broader contrast and
assistive-technology assessment.
