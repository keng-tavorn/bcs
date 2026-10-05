// Class names of the LIFF components (§9.4: a LIFF page's first JavaScript is at most 200 KB gzip with the LINE SDK and
// its page data). The workspace's src/ui/cn.ts resolves conflicting Tailwind classes with tailwind-merge — some 8.6 KB
// gzip in the first load of every page that draws one of its components; LIFF components do not need it: each writes its
// classes so that no two of them set the same thing (one size, one colour, one padding of a side), and a className a
// caller passes adds to them without overriding one. The workspace components a LIFF page draws join theirs with it too
// (src/ui/form/notice.tsx in a request's list of files, src/ui/admin-doa/boundary-confirm.tsx in a DOA version's
// decision). tests/unit/liff-classes.test.tsx draws them and compares their classes with what tailwind-merge would make
// of the same, and follows every LIFF page's imports to check that none of them brings tailwind-merge.

/** The class names that are set, joined with spaces: false, null, undefined and '' are left out; nothing is merged */
export function cn(...classes: ReadonlyArray<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
