# A Copy holds no File Connection

_Status: accepted (2026-10-03), settled in the #162 grilling on top of Felix's decision of
2026-09-27 that a **Copy** is a first-class File state. Not yet implemented._

Marking a File as a **Copy** of another File takes its File Connection apart. The Copy
then documents nothing on its own: the original is the one File the Transaction holds,
and the Copy is only shown beside it. Undoing the mark is not a Rejection, and the
unlink it caused records none, because the pair was never wrong.

Only a person may unlink a File to make it a Copy. A click, the chat agent and an MCP
call are the User acting, as they are for a Rejection; the matcher and every Sync are
not. When the system finds a Copy that is still unconnected, it records it, since no
File Connection is lost. When the Copy is connected, it only suggests.

## Why unlink, and not "connected but skipped"

The alternative was to leave the Copy connected and teach every reader of File
Connections to skip it. Today there are five readers, and with two copies of one invoice
connected to one Transaction, each one goes wrong in its own way:

- **Coverage** sums every connected File, so it reads about 200 % and the Remainder goes
  negative: the line looks over-documented.
- **The UVA** reconciles the bank amount against the Files' totals, sees twice the bank
  amount, and treats the line as a 50 % instalment. The input VAT comes out right only
  by accident. A foreign-currency line with two Files is refused outright, and the
  prior-instalment lookup can misfire.
- **The BMD Export** writes both file names into `extbelegnr` and ships both PDFs in the
  ZIP. This is the artefact the Tax Advisor judges us on.
- **Documentation State** is unaffected only because the copies share a Document Type.
- **The queues** count the line as documented while the second copy still sits as unmatched
  work.

"Skip Copies" would have to be added to all five, and to every reader written later. A
missed skip shows up as a wrong VAT figure, not as a crash. Unlinking keeps the existing
rule, connected means counted, so none of the five needs a change and nothing new has
to be remembered.

## Why only a person unlinks

A File Connection is the record that a document documents a line. Taking one apart
silently, on a matcher's guess, could leave a Transaction undocumented with nobody
looking. Recording a Copy for an unconnected File cannot do that, so the system may do
it alone.

## Consequences

- A Copy stays out of the queue while its original is live. When the original is
  deleted, the Copy is an ordinary File again. If the original is restored, it is a
  Copy again. A Purge of the original clears the mark. The Copy is never promoted on
  its own: moving a File Connection needs a person.
- Swapping which File is the original moves the File Connection to the other File in a
  single act.
- A pair ruled "not a Copy" is never suggested again.
