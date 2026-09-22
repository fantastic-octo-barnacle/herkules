// Vite+'s general TypeScript checker cannot load SFCs. The build separately runs
// vue-tsc to check component scripts and templates, including their actual props.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
