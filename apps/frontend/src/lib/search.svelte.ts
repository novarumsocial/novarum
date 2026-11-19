// shared by the search boxes in the channel header and the member list, and the results panel
export const messageSearch = $state({
  text: '',
  // what the results panel shows; it only changes on Enter, not on every keystroke
  query: null as string | null,
});
