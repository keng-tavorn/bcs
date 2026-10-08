// What a LIFF page never loads (§4.10 LIFF row, §5.5, ADR-052, FR-PLT-013 AC5): the workspace's libraries and its
// components. bcs/liff-imports reports a LIFF file that imports one (eslint.config.mjs), and tests/unit/liff-classes.test.tsx
// follows every LIFF page's imports to check that none of them comes in through another module.

/** Packages of the workspace: cmdk (⌘K), recharts (charts), the form helpers, the Drawer and toasts, the primitives of
 * shadcn/ui, and tailwind-merge, which src/ui/cn.ts brings */
export const LIFF_FORBIDDEN_PACKAGES = [
  'cmdk',
  'recharts',
  'react-dropzone',
  'input-otp',
  'react-day-picker',
  '@xyflow/react',
  'vaul',
  'sonner',
  'tailwind-merge',
  'radix-ui',
  '@radix-ui/*',
]

/** Modules of src (repo paths without extension): the shadcn/ui components, the class merger, the workspace's button */
export const LIFF_FORBIDDEN_PATHS = ['src/ui/shadcn/**', 'src/ui/cn', 'src/ui/form/button']
