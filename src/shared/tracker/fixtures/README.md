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
