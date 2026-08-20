export class DeviceStore {
  isComputer = $state(false);
  isPhone = $state(false);
  isPortrait = $state(false);
  isPhonePortrait = $derived(this.isPhone && this.isPortrait);

  constructor() {
    if (typeof window !== 'undefined') {
      const desktopQuery = window.matchMedia('(min-width: 1024px) and (pointer: fine)');
      const phoneQuery = window.matchMedia('(max-width: 767px) and (pointer: coarse)');
      const portraitQuery = window.matchMedia('(orientation: portrait)');

      this.isComputer = desktopQuery.matches;
      this.isPhone = phoneQuery.matches;
      this.isPortrait = portraitQuery.matches;

      desktopQuery.addEventListener('change', (e) => {
        this.isComputer = e.matches;
      });
      phoneQuery.addEventListener('change', (e) => {
        this.isPhone = e.matches;
      });
      portraitQuery.addEventListener('change', (e) => {
        this.isPortrait = e.matches;
      });
    }
  }
}

export const device = new DeviceStore();
