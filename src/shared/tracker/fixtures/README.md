# Real tracker modules, for acceptance testing

Hand-built buffers (`dsm-fixture.ts`, `../mod/fixture.ts`) test the byte-level
rules and are what CI relies on. These files test something those cannot: that a
decoder survives a module written by a real tracker, decades ago, by someone who
was not thinking about our parser.

They caught nothing on the way in — but the DSM offsets in `dsm.ts` were
*derived* from `race_against_time.dsm` rather than from a specification, and two
of them contradict the commonly cited layout. Without a real file to measure,
the decoder would have been wrong in two places. The IT reader's note-fade
handling was caught the same way, by `preparator.mptm` failing the MIDI range
assertion — see below.

Prefer the smallest file that exercises a format when adding to this directory.

## Provenance

| File | Format | Title | Author | modarchive id |
| --- | --- | --- | --- | --- |
| `race_against_time.dsm` | DSM | Race against time | flying_tigers | 214766 |
| `1995.mod` | MOD | 1995 | — | 80555 |
| `moving_that_rhythm.s3m` | S3M | S3M --> moving that rhythm | — | 69391 |
| `portal_to_hell.s3m` | S3M | Portal to hell | — | 54606 |
| `sunlight.xm` | XM | \|- sunlight -\| | — | 142447 |
| `dr_wily.xm` | XM | Dr Wily.... | Felix Lindgren | 58823 |
| `thereal1.it` | IT | The "REAL" One | c512w | 214787 |
| `preparator.mptm` | MPTM | Preparator | asikwp | 189288 |

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

**The two XM files also earn their places separately.** `sunlight.xm` has eight
instruments with no samples among its fifteen, so its instrument headers are a
mix of 33 and 263 bytes — a reader assuming the larger loses everything after
the first empty slot. `dr_wily.xm` holds a 76-row pattern among its 64s and four
patterns with no packed data at all, which is what pins the per-pattern row
count and the blank-pattern handling. Two larger XMs (`mercury.xm` 1.1 MB and
`1funk.xm` 777 KB) were measured while designing the decoder but cover nothing
these two do not.

**The IT pair pins the two things that format gets wrong quietly, and they are
complementary rather than redundant.** `thereal1.it` is the replay-bit
regression test: 1,246 of its 5,069 notes — a quarter — and nearly all of its
instrument assignments exist only as mask bits 16 and 32, which consume no
bytes. A reader that ignores them unpacks every pattern to exactly its declared
length, consumes exactly its declared bytes, passes every structural check, and
still loses a quarter of the music onto the wrong tracks. It is also the only
file here carrying both order-list markers: four 254 separators mid-list and a
trailing 255.

`preparator.mptm` covers what it does not. It is the MPTM, declaring
`cmwt == 0x0888` — note that `sadsong.it`, measured but not shipped, carries
OpenMPT's `OMPT` marker at offset 60 while being an ordinary IT, which is why
detection keys on `cmwt` instead. It has six distinct pattern lengths including
63 and 65 either side of 64, where an off-by-one in the row loop would hide. It
reaches **note 119**, which pins the note base at 0: at `note + 12` — the base
XM and DSM would suggest — that decodes to MIDI 131 and fails the range check.
And it holds four **note-fades** (253), an OpenMPT extension absent from all
four ITs measured; a reader written against IT alone emits MIDI 253 for them.
That last one was caught by the generic range assertion above, not by design.

Both IT files are drum kits, which corroborates the note base independently:
their lowest notes are 37 and 36, landing on the General MIDI bass drum rather
than an octave above it.

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
