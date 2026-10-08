# ruff: noqa: E501  (prose corpus: long lines are document text)
"""
Retrieval eval corpus: short original documents, written for this suite.

Clusters of look-alike documents (two pump models, two quarters of results,
two routers, two painkillers) are deliberate: an embedding sees them as near
neighbours, so queries naming a product code, a form number, a person or an
acronym test whether hybrid search recovers the exact one.
"""

DOCS: list[dict[str, str]] = [
    # --- pumps ---------------------------------------------------------------------
    {
        "id": "pump-zx4410",
        "title": "ZX-4410 centrifugal pump manual",
        "text": """
# ZX-4410 centrifugal pump

The ZX-4410 is a single-stage centrifugal pump for clean water at up to 40 m³/h.

## Priming

Before first use, open bleed valve V2, fill the volute through the priming port until water runs from V2,
then close V2. Never run the ZX-4410 dry: the mechanical seal overheats within seconds.

## Fault codes

E-17 means the impeller is blocked. Switch off, isolate power and clear debris through the inspection cover.
""",
    },
    {
        "id": "pump-zx4420",
        "title": "ZX-4420 centrifugal pump manual",
        "text": """
# ZX-4420 centrifugal pump

The ZX-4420 is the two-stage sibling of the smaller model, rated for 55 m³/h at higher head.

## Priming

Fill the casing through plug P1 with the discharge valve closed. The ZX-4420 has a self-venting casing,
so no bleed valve is fitted.

## Fault codes

E-22 signals low suction pressure; check the strainer and the inlet pipe for air leaks.
""",
    },
    {
        "id": "pump-kp90",
        "title": "KP-90 diaphragm pump guide",
        "text": """
# KP-90 air-operated diaphragm pump

The KP-90 moves viscous fluids such as paint, glue and sludge using two flexing diaphragms driven by
compressed air. It can run dry without damage and is self-priming up to 6 metres.
Replace the PTFE diaphragms every 2,000 operating hours or when the exhaust shows fluid.
""",
    },
    {
        "id": "pump-cavitation",
        "title": "Understanding pump cavitation",
        "text": """
# Cavitation

Cavitation happens when the pressure at a pump inlet falls below the vapour pressure of the liquid.
Bubbles form and then collapse violently against the impeller, pitting the metal and causing a rattling
noise like gravel. Raise the suction head, shorten the inlet pipe or lower the fluid temperature to stop it.
""",
    },
    # --- networking ----------------------------------------------------------------
    {
        "id": "router-ax86",
        "title": "RT-AX86 router quick setup",
        "text": """
# RT-AX86 quick setup

Connect the modem to the blue WAN port of the RT-AX86, then browse to 192.168.50.1.
The setup wizard asks for a new admin password and a network name. Enable Smart Connect to merge the
2.4 GHz and 5 GHz bands under one name. Firmware updates are under Administration, then Firmware Upgrade.
""",
    },
    {
        "id": "router-ax58",
        "title": "RT-AX58 firmware recovery",
        "text": """
# Recovering an RT-AX58 after a failed firmware update

If the power light blinks slowly, the RT-AX58 is in rescue mode. Give your computer the fixed address
192.168.1.10, run the Firmware Restoration utility and select the original image file. Do not switch the
router off until it restarts by itself, which takes about five minutes.
""",
    },
    {
        "id": "net-vlan",
        "title": "VLAN tagging explained",
        "text": """
# VLAN tagging

A VLAN splits one physical switch into several isolated networks. IEEE 802.1Q adds a four-byte tag carrying
a 12-bit VLAN ID to each Ethernet frame. Trunk ports carry tagged traffic for many VLANs between switches;
access ports carry untagged traffic for a single VLAN to an end device such as a printer.
""",
    },
    {
        "id": "net-wireguard",
        "title": "Setting up a WireGuard VPN",
        "text": """
# WireGuard

WireGuard is a lean VPN protocol built on Curve25519 key exchange and ChaCha20-Poly1305 encryption.
Each peer has a key pair; the server lists each client's public key and allowed IPs in wg0.conf.
Open UDP port 51820 on the firewall and bring the interface up with wg-quick up wg0.
""",
    },
    # --- health ----------------------------------------------------------------------
    {
        "id": "med-ibuprofen",
        "title": "Ibuprofen dosing for adults",
        "text": """
# Ibuprofen

Ibuprofen is a non-steroidal anti-inflammatory drug (NSAID). The usual adult dose is 200 to 400 mg every
four to six hours with food, up to 1,200 mg a day without medical advice. Avoid it with stomach ulcers,
severe asthma triggered by NSAIDs, or in late pregnancy.
""",
    },
    {
        "id": "med-paracetamol",
        "title": "Paracetamol dosing for adults",
        "text": """
# Paracetamol (acetaminophen)

Paracetamol relieves pain and fever but has little anti-inflammatory effect. Adults take 500 mg to 1 g every
four to six hours, never more than 4 g in 24 hours. Overdose damages the liver, sometimes without early
symptoms, so check combination cold remedies for hidden paracetamol.
""",
    },
    {
        "id": "med-migraine",
        "title": "Migraine overview",
        "text": """
# Migraine

A migraine is a throbbing headache, often on one side, lasting four to seventy-two hours, with nausea and
sensitivity to light. About a third of people have an aura first: zigzag lines or blind spots. Triptans
taken early in an attack work best; keeping a headache diary helps identify triggers such as missed meals.
""",
    },
    {
        "id": "med-acl",
        "title": "Rehabilitation after ACL reconstruction",
        "text": """
# ACL rehabilitation

After anterior cruciate ligament (ACL) reconstruction, the first two weeks focus on reducing swelling and
regaining full knee extension. Straight-leg raises and stationary cycling follow. Running usually resumes
around month four, and a return to pivoting sports such as football takes nine months or more.
""",
    },
    # --- finance ---------------------------------------------------------------------
    {
        "id": "fin-northwind-q3",
        "title": "Northwind Traders Q3 2025 results",
        "text": """
# Northwind Traders: third quarter 2025

Revenue reached 412 million, up 9 percent on the year, driven by the Nordic wholesale division.
Gross margin narrowed to 31.2 percent because of freight costs. The board kept the full-year guidance and
declared an interim dividend of 14 pence per share, payable in November.
""",
    },
    {
        "id": "fin-northwind-q2",
        "title": "Northwind Traders Q2 2025 results",
        "text": """
# Northwind Traders: second quarter 2025

Revenue was 389 million, up 6 percent, with growth in online retail offsetting weaker trade in Iberia.
Gross margin improved to 32.8 percent. Management announced a share buyback of up to 50 million
over twelve months.
""",
    },
    {
        "id": "fin-ebitda",
        "title": "What EBITDA measures",
        "text": """
# EBITDA

EBITDA is earnings before interest, taxes, depreciation and amortisation. It approximates operating cash
generation by ignoring financing choices and non-cash charges, which makes companies with different debt
loads easier to compare. It is not a cash-flow figure: it ignores working capital and capital spending.
""",
    },
    {
        "id": "fin-roth",
        "title": "Roth IRA versus traditional IRA",
        "text": """
# Roth or traditional IRA

A traditional IRA gives a tax deduction now and taxes withdrawals in retirement. A Roth IRA is funded with
after-tax money, and qualified withdrawals are tax-free. If you expect a higher tax bracket later, the Roth
usually wins. Roth contributions phase out at higher incomes.
""",
    },
    # --- software --------------------------------------------------------------------
    {
        "id": "sw-vacuum",
        "title": "PostgreSQL VACUUM and autovacuum",
        "text": """
# VACUUM in PostgreSQL

Because PostgreSQL uses MVCC, updates and deletes leave dead tuples behind. VACUUM marks that space reusable,
and VACUUM FULL rewrites the table to return space to the operating system but takes an exclusive lock.
Autovacuum triggers when dead tuples exceed autovacuum_vacuum_scale_factor of the table.
""",
    },
    {
        "id": "sw-hnsw",
        "title": "Tuning pgvector HNSW indexes",
        "text": """
# HNSW in pgvector

An HNSW index builds a layered proximity graph over vectors. The parameter m sets links per node and
ef_construction sets the candidate list while building; higher values improve recall but slow the build.
At query time, raise hnsw.ef_search for better recall. Iterative scans help when filters remove many rows.
""",
    },
    {
        "id": "sw-crashloop",
        "title": "Debugging CrashLoopBackOff in Kubernetes",
        "text": """
# CrashLoopBackOff

A pod in CrashLoopBackOff starts, exits and is restarted with growing delays. Run kubectl logs with
--previous to see the last crash, and kubectl describe pod for exit codes. Exit code 137 means the
container was OOMKilled: raise the memory limit or fix the leak.
""",
    },
    {
        "id": "sw-asyncio",
        "title": "Cancellation in Python asyncio",
        "text": """
# Cancelling asyncio tasks

Calling task.cancel() raises CancelledError inside the coroutine at its next await. Code should clean up
in a finally block and let the exception propagate. Since Python 3.11, asyncio.TaskGroup cancels sibling
tasks when one fails, and asyncio.timeout() replaces wait_for for deadlines.
""",
    },
    {
        "id": "sw-rust",
        "title": "The Rust borrow checker",
        "text": """
# Borrowing in Rust

Rust allows either one mutable reference or any number of shared references to a value at a time, never
both. The borrow checker enforces this at compile time, which rules out data races without a garbage
collector. Lifetimes tell the compiler how long references remain valid.
""",
    },
    # --- people ----------------------------------------------------------------------
    {
        "id": "hist-lovelace",
        "title": "Ada Lovelace and the Analytical Engine",
        "text": """
# Ada Lovelace

In 1843 Ada Lovelace translated an article on Charles Babbage's Analytical Engine and added notes three times
its length. Note G describes an algorithm to compute Bernoulli numbers, often called the first published
computer program. She foresaw machines composing music from symbols.
""",
    },
    {
        "id": "hist-hopper",
        "title": "Grace Hopper and the first compiler",
        "text": """
# Grace Hopper

Rear Admiral Grace Hopper wrote the A-0 system in 1952, an early compiler that turned symbolic code into
machine instructions. She later shaped COBOL, arguing that programs should read like English. A moth
taped into the Harvard Mark II logbook made "debugging" famous.
""",
    },
    {
        "id": "hist-turing",
        "title": "Alan Turing at Bletchley Park",
        "text": """
# Alan Turing

At Bletchley Park, Alan Turing designed the Bombe, an electromechanical machine that searched for Enigma
settings using cribs, guessed fragments of plaintext. Hut 8 under Turing broke the naval Enigma, which
helped protect Atlantic convoys from U-boats.
""",
    },
    {
        "id": "hist-lamarr",
        "title": "Hedy Lamarr's frequency hopping patent",
        "text": """
# Hedy Lamarr

The film star Hedy Lamarr and composer George Antheil patented a frequency-hopping system in 1942 to stop
radio-guided torpedoes being jammed. A piano-roll mechanism switched transmitter and receiver between 88
frequencies in step. Spread-spectrum ideas like this underpin modern Bluetooth.
""",
    },
    # --- cooking ---------------------------------------------------------------------
    {
        "id": "food-sourdough",
        "title": "Keeping a sourdough starter",
        "text": """
# Sourdough starter

A starter is a culture of wild yeast and lactic acid bacteria. Feed it equal weights of flour and water
every day at room temperature, discarding half first. It is ready to bake with when it doubles within four
to six hours and smells pleasantly sour.
""",
    },
    {
        "id": "food-pizza",
        "title": "Neapolitan pizza dough",
        "text": """
# Neapolitan dough

Use tipo 00 flour, water at 60 to 65 percent hydration, 3 percent salt and a little fresh yeast. Knead,
then ferment the dough balls for 8 to 24 hours. Bake for 60 to 90 seconds at about 450 °C, so the
cornicione puffs and leopard-spots.
""",
    },
    {
        "id": "food-omelette",
        "title": "A French omelette",
        "text": """
# French omelette

Beat three eggs with a pinch of salt. Melt butter in a nonstick pan over medium heat, add the eggs and stir
quickly with a fork while shaking the pan, so small soft curds form. Roll the omelette onto the plate while
it is still slightly runny inside, with no browning.
""",
    },
    {
        "id": "food-miso",
        "title": "Simple miso soup",
        "text": """
# Miso soup

Make dashi by steeping kombu in water, then adding katsuobushi flakes and straining. Add cubes of tofu and
wakame. Take the pot off the heat before whisking in the miso, because boiling dulls its aroma.
""",
    },
    # --- nature ----------------------------------------------------------------------
    {
        "id": "nat-owls",
        "title": "How owls hunt",
        "text": """
# Owls

Owls are nocturnal birds of prey. Comb-like serrations on their flight feathers break up turbulence, so
they fly almost silently. Asymmetric ear openings let a barn owl locate a mouse under snow by sound alone.
""",
    },
    {
        "id": "nat-bees",
        "title": "The honeybee waggle dance",
        "text": """
# Waggle dance

A forager returning to the hive performs a waggle dance on the comb. The angle of the waggle run relative
to vertical shows the direction of the food relative to the sun, and its duration encodes distance.
Karl von Frisch decoded the dance and shared the 1973 Nobel Prize.
""",
    },
    {
        "id": "nat-monarch",
        "title": "Monarch butterfly migration",
        "text": """
# Monarch migration

Each autumn, monarch butterflies from eastern North America fly up to 4,000 km to overwinter in oyamel fir
forests in central Mexico. The journey spans several generations; the migrating generation lives eight
months instead of a few weeks and navigates with a time-compensated sun compass.
""",
    },
    {
        "id": "nat-coral",
        "title": "Why corals bleach",
        "text": """
# Coral bleaching

Reef-building corals host zooxanthellae, algae that photosynthesise and feed them. When water stays about
1 °C above the usual summer maximum for weeks, corals expel the algae and turn white. If heat stress ends
soon, they can recover; prolonged bleaching kills them.
""",
    },
    # --- space -----------------------------------------------------------------------
    {
        "id": "space-jwst",
        "title": "The James Webb Space Telescope mirror",
        "text": """
# JWST mirror

The James Webb Space Telescope has a 6.5 m primary mirror made of 18 hexagonal beryllium segments coated in
gold, which reflects infrared light well. The segments folded for launch and were aligned in space by
actuators to within nanometres. A five-layer sunshield keeps the instruments below 50 kelvin.
""",
    },
    {
        "id": "space-voyager",
        "title": "Voyager 1 in interstellar space",
        "text": """
# Voyager 1

Launched in 1977, Voyager 1 crossed the heliopause in August 2012, becoming the first spacecraft in
interstellar space. Its plasma wave instrument detected denser plasma beyond the boundary. The
radioisotope thermoelectric generators lose about four watts a year, so instruments are switched off one by one.
""",
    },
    {
        "id": "space-moxie",
        "title": "MOXIE: making oxygen on Mars",
        "text": """
# MOXIE

The Mars Oxygen In-Situ Resource Utilization Experiment rode on the Perseverance rover. It split carbon dioxide
from the Martian air by solid oxide electrolysis at 800 °C, producing up to 12 grams of oxygen an hour,
showing that propellant and breathable air could be made on Mars.
""",
    },
    {
        "id": "space-iss",
        "title": "The orbit of the International Space Station",
        "text": """
# ISS orbit

The International Space Station orbits about 400 km up at 7.66 km/s, circling Earth roughly every 92 minutes,
so the crew sees 16 sunrises a day. Atmospheric drag lowers the orbit steadily, and visiting vehicles fire
their engines in reboost manoeuvres to raise it.
""",
    },
    # --- internal policies -----------------------------------------------------------
    {
        "id": "pol-travel",
        "title": "Travel expense policy",
        "text": """
# Travel expenses

Book flights through the travel desk at least 14 days ahead; economy class for trips under six hours.
Claim expenses within 30 days on form TE-12 with itemised receipts. The daily meal allowance is 45 euros,
and alcohol is not reimbursed.
""",
    },
    {
        "id": "pol-leave",
        "title": "Parental leave policy",
        "text": """
# Parental leave

Every new parent, including adoptive parents, gets 20 weeks of paid leave at full salary, to be taken within
the first year. Notify your manager and HR at least eight weeks before the start date using form HR-7.
Leave can be split into up to three blocks.
""",
    },
    {
        "id": "pol-laptop",
        "title": "Laptop security policy",
        "text": """
# Laptop security

All company laptops must enrol in mobile device management (MDM) before first use. Full-disk encryption
stays on, screens lock after five minutes, and only the security team may grant local admin rights.
Report a lost device to the service desk within one hour so it can be wiped remotely.
""",
    },
    {
        "id": "pol-incidents",
        "title": "Incident severity levels",
        "text": """
# Incident severity

SEV1 is a complete outage or data breach affecting customers: page the on-call engineer and the incident
commander at once. SEV2 is a major feature down with a workaround. SEV3 is degraded performance; SEV4 is
cosmetic. Every SEV1 and SEV2 gets a blameless postmortem within five working days.
""",
    },
    # --- regulation ------------------------------------------------------------------
    {
        "id": "law-gdpr17",
        "title": "GDPR Article 17: right to erasure",
        "text": """
# Right to erasure

Article 17 of the GDPR lets a person ask a controller to erase their personal data without undue delay,
for example when it is no longer needed or consent is withdrawn. Exceptions include freedom of expression,
legal obligations and archiving in the public interest.
""",
    },
    {
        "id": "law-hipaa",
        "title": "HIPAA minimum necessary standard",
        "text": """
# Minimum necessary

Under the HIPAA Privacy Rule, covered entities must make reasonable efforts to use or disclose only the
minimum protected health information needed for a purpose. It does not apply to disclosures to the patient
or between providers for treatment.
""",
    },
]


# --- look-alike families --------------------------------------------------------------
# Real collections hold many near-identical documents: a catalogue of pump
# models, years of quarterly reports, a queue of support tickets. Their
# embeddings sit almost on top of each other, so a question naming one model,
# one quarter, one ticket or one customer needs the exact terms. Generated
# deterministically from templates (original text, fixed seeds).

_FAULTS = [
    "the impeller is blocked", "suction pressure is low", "the motor is overheating", "the seal is leaking",
    "the flow sensor has failed", "the supply voltage is out of range", "the bearing temperature is high",
    "the discharge valve is closed",
]  # fmt: skip
_EVENTS = [
    "announced a share buyback of up to {x} million",
    "declared an interim dividend of {y} pence per share",
    "completed the acquisition of a logistics firm for {x} million",
    "opened a distribution centre in {city}",
    "cut full-year guidance after weak demand in {city}",
    "issued a {x} million green bond",
]
_CITIES = ["Rotterdam", "Lyon", "Gdansk", "Porto", "Leeds", "Turin", "Ghent", "Malmo"]
_ISSUES = [
    (
        "cannot sign in after the password reset",
        "cleared the stale session and asked the customer to sign in again",
    ),
    ("was charged twice on the March invoice", "refunded the duplicate charge and corrected the invoice"),
    (
        "sees files syncing very slowly from the laptop",
        "raised the upload limit and restarted the sync agent",
    ),
    ("lost access to a shared folder", "restored the folder permissions from the audit log"),
    ("gets an error exporting reports to CSV", "applied the export fix and re-ran the report"),
    ("wants to move the account to another region", "scheduled the region migration for the weekend"),
]
_FIRST = ["Marta", "Jonas", "Priya", "Tomasz", "Aoife", "Kwame", "Elif", "Rafael", "Sanna", "Hiro"]
_LAST = ["Ilves", "Brandt", "Raman", "Nowak", "Byrne", "Mensah", "Kaya", "Duarte", "Virtanen", "Sato"]


def _pump_family() -> list[dict[str, str]]:
    import random

    rnd = random.Random(7)
    codes = [f"{p}-{n}" for p in ("HV", "MT", "QX", "LB", "RG") for n in range(210, 310, 10)]
    faults = rnd.sample(range(10, 100), len(codes))
    kits = rnd.sample(range(1000, 10000), len(codes))
    docs = []
    for code, fault, kit in zip(codes, faults, kits, strict=True):
        stages = rnd.choice(["single", "two", "three"])
        flow, head = rnd.randint(8, 90), rnd.randint(12, 80)
        hours = rnd.choice([2000, 4000, 6000, 8000])
        docs.append(
            {
                "id": f"cat-{code.lower()}",
                "title": f"{code} pump data sheet",
                "text": (
                    f"# {code} centrifugal pump\n\nThe {code} is a {stages}-stage centrifugal pump for clean water, "
                    f"rated for {flow} m³/h at {head} m head.\n\n## Maintenance\n\nFault code F-{fault} means "
                    f"{rnd.choice(_FAULTS)}. Replace seal kit SK-{kit} every {hours} operating hours and check the "
                    f"coupling alignment at each service."
                ),
            }
        )
    return docs


def _reports_family() -> list[dict[str, str]]:
    import random

    rnd = random.Random(11)
    docs = []
    for company in ("Contoso", "Fabrikam", "Tailspin Toys", "Adventure Works"):
        for year in (2024, 2025):
            for q, name in ((1, "first"), (2, "second"), (3, "third"), (4, "fourth")):
                revenue = rnd.randint(120, 900)
                margin = round(rnd.uniform(18, 42), 1)
                event = rnd.choice(_EVENTS).format(
                    x=rnd.randint(10, 300), y=rnd.randint(3, 30), city=rnd.choice(_CITIES)
                )
                slug = company.lower().replace(" ", "-")
                docs.append(
                    {
                        "id": f"rep-{slug}-{year}-q{q}",
                        "title": f"{company} Q{q} {year} results",
                        "text": (
                            f"# {company}: {name} quarter {year}\n\nRevenue was {revenue} million and gross margin "
                            f"was {margin} percent. During the quarter the company {event}. The board will "
                            f"report again after the next quarter closes."
                        ),
                    }
                )
    return docs


def _ticket_family() -> list[dict[str, str]]:
    import random

    rnd = random.Random(23)
    numbers = rnd.sample(range(40000, 49999), 40)
    names = [f"{f} {last}" for f in _FIRST for last in _LAST]
    customers = rnd.sample(names, 40)
    docs = []
    for number, customer in zip(numbers, customers, strict=True):
        issue, fix = rnd.choice(_ISSUES)
        docs.append(
            {
                "id": f"tkt-{number}",
                "title": f"Support ticket INC-{number}",
                "text": (
                    f"# INC-{number}\n\nCustomer {customer} {issue}. The support engineer {fix}. "
                    f"Status: resolved. The customer confirmed the fix by email."
                ),
            }
        )
    return docs


DOCS.extend(_pump_family())
DOCS.extend(_reports_family())
DOCS.extend(_ticket_family())


def family_cases() -> list[dict[str, object]]:
    """Cases about specific family members, phrased the way people ask."""
    out: list[dict[str, object]] = []
    n_pump = n_ticket = 0
    for d in DOCS:
        if d["id"].startswith("cat-"):
            n_pump += 1
            code = d["title"].split()[0]
            kit = d["text"].split("seal kit ")[1].split()[0]
            fault = d["text"].split("Fault code ")[1].split()[0]
            query = (
                f"seal kit for the {code}",
                f"what does fault {fault} mean",
                f"which pump uses {kit}",
            )[n_pump % 3]
            if n_pump % 2:
                out.append({"query": query, "relevant": [d["id"]], "type": "family"})
        elif d["id"].startswith("rep-") and d["id"].endswith(("2024-q1", "2025-q3")):
            company, quarter, year = (
                d["title"].rsplit(" ", 3)[0],
                d["title"].split()[-3],
                d["title"].split()[-2],
            )
            out.append(
                {"query": f"{company} {quarter} {year} revenue", "relevant": [d["id"]], "type": "family"}
            )
        elif d["id"].startswith("tkt-"):
            n_ticket += 1
            ticket = d["title"].split()[-1]
            customer = " ".join(d["text"].split("Customer ")[1].split()[:2])
            if n_ticket % 3 == 0:
                out.append({"query": f"how was {ticket} resolved", "relevant": [d["id"]], "type": "family"})
            elif n_ticket % 3 == 1:
                out.append({"query": f"ticket from {customer}", "relevant": [d["id"]], "type": "family"})
    return out
