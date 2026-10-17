// Port of the "appearance" tab of apps/frontend/src/lib/components/settings-dialog.svelte
// (Custom CSS is web-only; "Compact mode" is a disabled stub on the web, so it is hidden)
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { SettingsRow } from '@/components/settings-row';
import { Switch } from '@/components/ui/switch';
import { useSettings } from '@/lib/settings';

export default function Appearance() {
  const darkMode = useSettings((s) => s.darkMode);
  const circleIcons = useSettings((s) => s.circleIcons);
  const showMemberList = useSettings((s) => s.showMemberList);
  const update = useSettings((s) => s.update);

  return (
    <SettingsPage description="Make Novarum look the way you like.">
      <SettingsGroup title="Theme">
        <SettingsRow title="Dark mode" description="Use the dark color scheme.">
          <Switch value={darkMode} onValueChange={(value) => update({ darkMode: value })} />
        </SettingsRow>
        <SettingsRow
          title="Round icons"
          description="Show avatars and server icons as circles instead of squares."
        >
          <Switch value={circleIcons} onValueChange={(value) => update({ circleIcons: value })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Layout">
        <SettingsRow title="Show member list" description="Display the member sidebar in channels.">
          <Switch
            value={showMemberList}
            onValueChange={(value) => update({ showMemberList: value })}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
