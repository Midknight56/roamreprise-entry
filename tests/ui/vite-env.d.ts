declare module '*?raw' {
  const contents: string;
  export default contents;
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { eager: true; query: string; import: string },
  ): Record<string, T>;
}
