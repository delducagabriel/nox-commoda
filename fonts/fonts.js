/*
 * Manifesto de fontes para quando o index.html é aberto direto do disco (file://).
 * O Chrome bloqueia a leitura do fonts.json nesse modo, então liste as fontes aqui também.
 *
 * Font manifest used when index.html is opened from disk (file://), where
 * browsers block fetch() of fonts.json. Same format as fonts.json.
 */
window.NOX_FONTS = [
  // { name: "Minha Fonte", file: "MinhaFonte-Regular.ttf" },
];
