# Real tracker modules, for acceptance testing

Hand-built buffers (`dsm-fixture.ts`, `../mod/fixture.ts`) test the byte-level
rules and are what CI relies on. These files test something those cannot: that a
decoder survives a module written by a real tracker, decades ago, by someone who
was not thinking about our parser.

They caught nothing on the way in — but the DSM offsets in `dsm.ts` were
*derived* from `race_against_time.dsm` rather than from a specification, and two
of them contradict the commonly cited layout. Without a real file to measure,
the decoder would have been wrong in two places.

Prefer the smallest file that exercises a format when adding to this directory.

## Provenance

| File | Format | Title | Author | modarchive id |
| --- | --- | --- | --- | --- |
| `race_against_time.dsm` | DSM | Race against time | flying_tigers | 214766 |
| `1995.mod` | MOD | 1995 | — | 80555 |
| `moving_that_rhythm.s3m` | S3M | S3M --> moving that rhythm | — | 69391 |
| `portal_to_hell.s3m` | S3M | Portal to hell | — | 54606 |

**`portal_to_hell.s3m` is kept for a specific reason, not as another sample.**
Every one of its 31 patterns yields 62-63 rows rather than 64, and most run one
byte past their declared length — the writer omits trailing empty rows and
sometimes the final terminator. It is the regression test for that handling: a
decoder written from the S3M specification rejects this file outright. It also
sets a speed of 1, which is what exposed `effectiveBpm` producing 750 BPM and
failing validation.

`moving_that_rhythm.s3m` decodes perfectly and is kept for the opposite reason:
it enables 16 channels in its header while its patterns only reach 0-8, which is
what pins the channel-width rule.

Downloadable from `https://api.modarchive.org/downloads.php?moduleid=<id>`.

## On copyright

These modules are their authors' copyright. The Mod Archive distributes them for
download; that is not the same as a licence to redistribute them inside this
repository, and no such licence has been established for these files.

Committing them here was a deliberate decision by the repository owner, taken
with that stated. This table exists so the origin of every file is traceable and
the decision can be revisited — by swapping in permissively licensed modules, or
by moving the corpus out of the repository and having these tests skip when it
is absent.
