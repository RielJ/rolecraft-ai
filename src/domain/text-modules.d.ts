// Bun imports a file's contents as a string with `with { type: "text" }` (guide.ts).
declare module "*.md" {
  const text: string;
  export default text;
}
