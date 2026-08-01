# SQLite Application ID

fsqlite snapshots and sealed exports use the fixed SQLite `application_id` `0x4653514C`
(decimal `1179865420`, ASCII `FSQL`). Callers own `PRAGMA user_version` for their schema
version; it is not used for fsqlite file identity.

SQLite stores `application_id` as a four-byte big-endian integer at database-header
offset 68. The value lets tools distinguish an application file format from a generic
SQLite database.

## Collision Check

On 2026-07-31, `0x4653514C` did not appear in SQLite’s published `magic.txt` list at
`sqlite/sqlite` commit `f034d515b4208e1c9325271aef3dc4901f24e216`. The chosen bytes
spell `FSQL`, making accidental reuse less likely and the header recognizable in a hex
dump.

The corresponding `file(1)` rule is:

```text
0    string  =SQLite\ format\ 3
>68  belong  =0x4653514c  fsqlite store snapshot -
```

SQLite’s list is a set of suggested `file(1)` rules, not a centralized allocation
authority.
SQLite’s own forum directs applications seeking system-wide recognition to the
maintainers of libmagic/file rather than treating SQLite as the registry.
Adding the rule upstream is therefore a separate integration step; the value is already
fixed and enforced by the `f1.0` format.

Sources: [SQLite database file format](https://sqlite.org/fileformat.html),
[SQLite `magic.txt`](https://github.com/sqlite/sqlite/blob/master/magic.txt), and
[SQLite forum clarification](https://sqlite.org/forum/forumpost/c73d9a274737344d).

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
