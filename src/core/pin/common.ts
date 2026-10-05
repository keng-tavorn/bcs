// Six-digit PINs people choose so often that an attacker tries them first (FR-AUTH-005 AC1: "ห้าม PIN ที่เดาง่าย").
// The two rules of ./index.ts already refuse one digit six times and runs that go up or down by one, so none of those
// is repeated here (tests/unit/pin.test.ts checks that). The groups follow the patterns that published analyses of
// real PIN choices rank highest: repeated blocks, mirrored runs, doubled runs, lines and shapes on a phone keypad, and
// numbers people know by heart. Nearly a million other PINs remain to choose from.
//
// Each group is one string of PINs separated by spaces, not an array of six-digit strings: bcs/no-money-literal reads
// every string of four digits or more in src as an amount of money, and a PIN is not one.

const GROUPS = {
  /** Two digits, three times */
  pairs: `
    010101 020202 030303 040404 050505 060606 070707 080808 090909 101010 121212 131313
    141414 151515 161616 171717 181818 191919 202020 212121 232323 242424 252525 262626
    272727 282828 292929 303030 313131 323232 343434 353535 363636 373737 383838 393939
    404040 414141 424242 434343 454545 464646 474747 484848 494949 505050 515151 525252
    535353 545454 565656 575757 585858 595959 606060 616161 626262 636363 646464 656565
    676767 686868 696969 707070 717171 727272 737373 747474 757575 767676 787878 797979
    808080 818181 828282 838383 848484 858585 868686 878787 898989 909090 919191 929292
    939393 949494 959595 969696 979797 989898`,
  /** A run of three digits, twice */
  runTwice: `
    012012 123123 234234 345345 456456 567567 678678 789789 987987 876876 765765 654654
    543543 432432 321321 210210`,
  /** Other blocks of three digits, twice */
  blockTwice: `
    520520 521521 147147 258258 369369 159159 357357 753753 951951 741741 852852 963963
    100100 200200 101101 110110 001001 168168 518518 007007`,
  /** A run of doubled digits */
  doubledRun: `
    001122 112233 223344 334455 445566 556677 667788 778899 998877 887766 776655 665544
    554433 443322 332211 221100`,
  /** Three of one digit and three of the next, and round halves */
  halves: `
    000111 111222 222333 333444 444555 555666 666777 777888 888999 999888 888777 777666
    666555 555444 444333 333222 222111 111000 000999 999000 000123 123000`,
  /** A run followed by its mirror, and other mirrored halves */
  mirror: `
    012210 123321 234432 345543 456654 567765 678876 789987 987789 876678 765567 654456
    543345 432234 321123 210012 112211 121121 122221 211112`,
  /** Lines, diagonals and shapes on a phone keypad (1 2 3 / 4 5 6 / 7 8 9 / 0) */
  keypad: `
    147258 258369 147369 369258 369147 258147 963852 852741 741852 852963 963741 741963
    159357 357159 159753 753159 951357 357951 951753 753951 159951 357753 753357 951159
    456123 789456 123789 789123 321654 654987 987321 147852 258456 852456 456852 258852
    147741 369963 123654 654123 147896 963258 125874 478963 258000 000258`,
  /** Numbers known by heart, steps of two and round numbers */
  known: `
    102030 010203 112358 314159 271828 142857 246810 135790 135791 135246 246135 121314
    100000 200000 300000 500000 131420 520131 584520 123412 123455 123457 123450 000007
    700000`,
} as const

function split<T extends Readonly<Record<string, string>>>(groups: T): { readonly [K in keyof T]: readonly string[] } {
  const out: Record<string, readonly string[]> = {}
  for (const [name, text] of Object.entries(groups)) out[name] = text.trim().split(/\s+/)
  return out as { readonly [K in keyof T]: readonly string[] }
}

/** The common PINs, by group name (tests read the groups) */
export const COMMON_PIN_GROUPS = split(GROUPS)

/** Every common PIN */
export const COMMON_PINS: ReadonlySet<string> = new Set(Object.values(COMMON_PIN_GROUPS).flat())
