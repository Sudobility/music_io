/**
 * Type stubs for the React Native native modules this entry uses.
 *
 * Declared here rather than installed, following the same convention as
 * `@sudobility/di`'s `src/rn/types.d.ts`: pulling in `react-native-fs` and
 * `react-native-share` for their types would drag `react-native` itself into
 * this package's dev tree for no benefit, since neither can run outside a
 * device anyway. They are optional peers; a React Native app supplies the real
 * ones.
 *
 * Only the members `file.rn.ts` actually calls are declared. Widening these to
 * the libraries' full APIs would invite use of members that have not been
 * thought about on this side of the boundary.
 */
declare module 'react-native-fs' {
  export const CachesDirectoryPath: string;
  export function writeFile(path: string, contents: string, encoding: string): Promise<void>;
  const RNFS: { CachesDirectoryPath: string; writeFile: typeof writeFile };
  export default RNFS;
}

declare module 'react-native-share' {
  export type ShareOpenOptions = {
    url?: string;
    type?: string;
    failOnCancel?: boolean;
  };
  const Share: { open(options: ShareOpenOptions): Promise<unknown> };
  export default Share;
}
