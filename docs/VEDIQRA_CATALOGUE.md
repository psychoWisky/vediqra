# VEDIQRA catalogue — modelling notes

**Status: DRAFT. Nothing in this document has been approved by the client.**
The structure below is our working interpretation of the client's rough list. Every place where we had to
guess is marked **CLIENT CONFIRMATION REQUIRED**. Do not launch, price or photograph from this document
until those points are answered.

The seed is `database/seeds/vediqra_catalogue.sql` (insert-only, safe to re-run). It follows this document exactly.

---

## 1. Placeholder policy (read this first)

| Item | What the seed does | Why |
|---|---|---|
| **Prices** | Every product has `price = 0`. Every option price modifier is `0`. | The client has supplied **no prices**. `0` is a marker for "not priced yet", **not** a real or intended price. |
| **Visibility** | Every product is `is_active = false` (hidden from the shop). | So nothing unpriced can appear or be bought. |
| **Server guard** | The order/pricing code refuses to sell any line whose price is 0 ("not available for purchase yet"). | Defence in depth: activating a product without pricing it cannot create a free order. |
| **Images** | All image fields are `NULL`. No GFTD images, no stock photos, nothing generated. | None supplied. |
| **Stock** | `track_stock = false` (made to order), option stock `NULL` (not tracked). | Stock policy not supplied. See "Stock" below. |
| **Reviews / orders / customers / social proof / statistics** | None created. `social_proof_enabled = false`. | Must never be invented. |
| **Customization limits** | 3 text lines, 50 characters per line, 5 images, fee 0, on every product. | **PLACEHOLDERS.** The client has not said what can be personalised or how much. |

To put a product live: set the real price (and option price modifiers), add images, check the options, then activate it in the admin.

## 2. Category hierarchy

Two levels (enforced by the database). Ten top-level categories; "T-Shirts" has two subcategories.

```
Mug
Sipper
Cushion
School Bags
Mouse Pads
MDF Frames
Wall Hanging
T-Shirts
 ├─ Vinyl Printing
 └─ Sublimation
Kids
Metal Sheet
```

**CLIENT CONFIRMATION REQUIRED**
- The client listed "Vinyl printing tshirt" and "Sublimation" as two separate top-level sections. We nested both
  under a "T-Shirts" parent (as suggested in the brief). If "Sublimation" will also contain things that are not
  t-shirts (mugs, cushions...), it should probably stay top-level, or become a *technique* option instead.
- Browsing a parent category (T-Shirts) includes the products of its subcategories.

## 3. Products, options and categories

"Product" = its own page, photos and price. "Option" = a choice the customer makes on one product. The generic
option system supports either; where the client's list did not make clear which one it is, we picked the
simplest reading and flagged it.

| Product (slug) | Category | Option group (required?) | Option values (client's original wording where it differed) |
|---|---|---|---|
| **Mug** (`mug`) | Mug | **Mug Type** (required) | Plain · Heart Handle Plain · Inner Colour · Magic Mug · Magic Mug Inner Colour · Heart Handle Magic Mug · Golden Mug |
| **Pen Holder** (`pen-holder`) | Mug | — | — |
| **Pot Holder** (`pot-holder`) | Mug | — | — |
| **Sipper Bottle** (`sipper-bottle`) | Sipper | — | — |
| **Sports Bottle** (`sports-bottle`) | Sipper | — | — |
| **Cushion** (`cushion`) | Cushion | **Cushion Type** (required) | Heart Fur · Square Fur · LED Heart Fur · LED Square Fur · Baby Pillow · Album Pillow · Satin Pillow · Magic Fur |
| **School Bag** (`school-bag`) | **School Bags AND Kids** | — | — |
| **Mouse Pad** (`mouse-pad`) | Mouse Pads | **Size** (attached but *switched off*) | 7.5 inch · 9 inch — both inactive (see below) |
| **MDF Frame** (`mdf-frame`) | MDF Frames | **Frame Type** (required) | Wall Frame · Wall Clock Frame · Table Top Frame |
| **Wall Hanging** (`wall-hanging`) | Wall Hanging | **Design** (required) | General Quote · Devotional Quote · Krishna · Hanuman Ji · Shyam Baba · Tea MDF · Fast Food |
| **Vinyl Printing T-Shirt** (`vinyl-printing-t-shirt`) | T-Shirts › Vinyl Printing | **Finish** (required) | Solid Colour · Glitter (client: "Glitters") · Holographic ("Holographic s") · Reflective · Rainbow Reflective · Chameleon ("Chamelom") · Blue Chameleon · Red Chameleon ("Red chameloen") · HD 0.5 mm ("HD .5 mm") |
| **Sublimation T-Shirt** (`sublimation-t-shirt`) | T-Shirts › Sublimation | **Finish** (optional) | Holographic ("Holographic s") · Glitter · Rainbow Reflective (client: "Rainbow reflector") · Glow in Dark · Chameleon ("Chamelion") |
| **Tiffin Box** (`tiffin-box`) | Kids | — | — |
| **Pillow Bag** (`pillow-bag`) | Kids | — | — |
| **Magic Pencil Box** (`magic-pencil-box`) | Kids | — | — |
| **Metal Sheet** (`metal-sheet`) | Metal Sheet | — | — |

16 products, 7 attached option groups, 41 option values. Each option value keeps the client's original spelling in
`metadata.source_wording` when we corrected it, so nothing is lost.

## 4. Products vs options vs designs — what we assumed

| Decision | We assumed | Alternative | Status |
|---|---|---|---|
| Mug styles (plain, heart handle, inner colour, magic, golden) | **Options** of one "Mug" product | 7 separate products (own photo/price each) | **CLIENT CONFIRMATION REQUIRED** — depends on whether each style has its own price and photos |
| Pen holder, pot holder | Separate products (different objects) | Mug Type values | **CLIENT CONFIRMATION REQUIRED** |
| Sipper bottle / sports bottle | Separate products (different bottles) | "Bottle Type" option | **CLIENT CONFIRMATION REQUIRED** |
| Cushion types (fur, LED, baby/album/satin pillow, magic fur) | **Options** of one "Cushion" product | 8 separate products | **CLIENT CONFIRMATION REQUIRED** — baby/album/satin pillows look like different products; LED variants likely differ in price |
| Wall frame / wall **clock** frame / table top frame | **Options** of one "MDF Frame" product | 3 products | **CLIENT CONFIRMATION REQUIRED** — a clock frame is arguably a different product |
| Wall hanging themes (Krishna, Hanuman Ji, Shyam Baba, quotes, Tea MDF, Fast Food) | **Design** options of one product | Separate products, or a design library the customer picks from | **CLIENT CONFIRMATION REQUIRED** — "Tea MDF" and "Fast Food" may be product themes rather than religious designs |
| Vinyl finishes (solid, glitter, holographic, reflective, chameleon...) | **Finish** options | — | Reasonable reading; prices per finish still needed |
| Sublimation finishes | **Finish** options, *optional* (the client's list starts with a plain "T-shirt", so "no finish" = plain shirt) | Required finish | **CLIENT CONFIRMATION REQUIRED** |
| Vinyl vs sublimation T-shirt | Two products (different process, different finishes) | One T-shirt product with a "Print Method" option | **CLIENT CONFIRMATION REQUIRED** |
| School Bag in "School bag" and "Kids" | **One product in two categories** | — | Firm: one row, two `product_categories` links |
| T-shirt sizes, colours, kids sizes, etc. | **Not created** | — | **CLIENT CONFIRMATION REQUIRED** — the list gives none; we did not invent any |

### Mouse pad size wording — not interpreted
The client wrote **"7.5 m to 9 inch"**. That is probably "7.5 inch to 9 inch", but it could mean a range of sizes
or two fixed sizes, and "m" is unexplained. The seed records the original wording in `metadata.source_wording`
and attaches a **Size** group that is switched **off** (not required, not active), with two **inactive** values
"7.5 inch" and "9 inch" flagged `needs_confirmation`. **CLIENT CONFIRMATION REQUIRED:** what sizes exist.

### Spelling
We normalised obvious typos (Chamelom / Chameloen / Chamelion → Chameleon, "Holographic s" → Holographic,
"Glitters" → Glitter). The brief for this phase lists the sublimation finish as "Rainbow Reflective" while the
client's own list says "Rainbow reflector" — we used the former. **CLIENT CONFIRMATION REQUIRED** on final naming.

## 5. Customization

Every product is marked customizable (the client describes VEDIQRA as "personalized/customized gifting and
printing"), with the placeholder limits in section 1. **CLIENT CONFIRMATION REQUIRED:**
- Which products can really be personalised (a raw "Metal Sheet" or "Pen Holder" may not).
- Text or photo or both, how many lines/characters/images, and any customization fee.
- For finishes such as "Chameleon" or "Glow in Dark": whether they change what artwork can be printed.

## 6. Images required from the client

None exist yet. Needed before launch:
- **One primary photo per product** (16), plus extra angles.
- **One image per option value where the look matters:** Mug Type (7), Cushion Type (8), Frame Type (3), Design
  (7 wall hangings), Vinyl finishes (9), Sublimation finishes (5). Option values have their own `image_url`.
- Category images/banners (12) if the storefront design uses them.
- Artwork rules for customer uploads (minimum resolution, file types, safe area).

## 7. Stock behaviour (implemented in Phase 3A)

| Field | Meaning |
|---|---|
| Option value `stock_quantity` = **NULL** | Not tracked — unlimited. (The seed's default.) |
| Option value `stock_quantity` = a number | Enforced and decremented on every order. |
| Product `track_stock` = **false** | Made to order; `stock_quantity` is only informational. (The seed's default.) |
| Product `track_stock` = **true** | `stock_quantity` is enforced and decremented. |

- The server never trusts stock sent by the browser.
- Stock is taken **atomically when the order is saved**, inside the order transaction: a conditional
  `UPDATE ... WHERE stock >= quantity` per row. Simultaneous orders queue on the row, so a unit cannot be sold twice.
  If any part of the order fails, every decrement is rolled back.
- **Cash on delivery:** the order is saved (and stock taken) when the customer places it.
- **Online payment (Razorpay):** nothing is reserved when the Razorpay order is created, because the customer may
  never pay. Stock is taken when the *paid* order is saved. If it sold out in between, the payment is refunded
  automatically (best effort; if the refund call fails, the error is logged with the payment id for manual refund
  and the customer is told to contact support).
- Cart, quote and Razorpay-order creation also check stock early so customers get a friendly message.
- Combos: a combo's member products and their options count `member quantity × combo quantity`.
- **Not done:** stock is not returned when an order is cancelled or refunded — restock manually for now.

## 8. Open questions for the client (summary)

1. Prices for every product, and price differences per option (mug type, cushion type, finish, frame type, design, size).
2. For each catalogue line: separate product, or a choice inside another product? (section 4)
3. Mouse pad sizes ("7.5 m to 9 inch"). (section 4)
4. T-shirt sizes/colours (and kids' sizes) — none were supplied.
5. Is "Sublimation" a t-shirt technique only, or a wider section? (section 2)
6. Which products can be personalised, with what limits and fees. (section 5)
7. Photos, category imagery and artwork requirements. (section 6)
8. Stock policy: made to order, or real stock counts for some items?
9. Shipping and cash-on-delivery charges (currently the old GFTD defaults: ₹79 under ₹499, ₹49 COD fee).

## 9. Do not start until the client has confirmed

- Setting real prices or activating any product (nothing here is priced).
- Photography, image uploads or any image production.
- Splitting or merging products (mug/cushion/frame/sipper/wall hanging) — this changes URLs, SEO and the seed.
- Building storefront pages that assume the current option groups (the option structure may change).
- Marketing copy, product descriptions or SEO text (none exists; do not invent it).
- Launching customization rules (limits and fees are placeholders).
