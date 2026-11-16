// Port of the "appearance" tab of apps/frontend/src/lib/components/settings-dialog.svelte
// (Custom CSS is web-only; "Compact mode" is a disabled stub on the web, so it is hidden.) Native additions:
// "Match system" follows the phone's theme, and "Show member list" only shows where there is room for the
// member column (on phones members open as their own screen).
import { useWindowDimensions } from 'react-native';
import { SettingsGroup, SettingsPage } from '@/components/settings-group';
import { SettingsSwitchRow } from '@/components/settings-row';
import { useSettings } from '@/lib/settings';

export default function Appearance() {
  const darkMode = useSettings((s) => s.darkMode);
  const followSystemTheme = useSettings((s) => s.followSystemTheme);
  const circleIcons = useSettings((s) => s.circleIcons);
  const showMemberList = useSettings((s) => s.showMemberList);
  const update = useSettings((s) => s.update);
  const { width } = useWindowDimensions();

  return (
    <SettingsPage description="Make Novarum look the way you like.">
      <SettingsGroup title="Theme">
        <SettingsSwitchRow
          title="Match system"
          description="Use your phone's light or dark setting."
          value={followSystemTheme}
          onValueChange={(value) => update({ followSystemTheme: value })}
        />
        <SettingsSwitchRow
          title="Dark mode"
          description="Use the dark color scheme."
          value={darkMode}
          disabled={followSystemTheme}
          onValueChange={(value) => update({ darkMode: value })}
        />
        <SettingsSwitchRow
          title="Round icons"
          description="Show avatars and server icons as circles instead of squares."
          value={circleIcons}
          onValueChange={(value) => update({ circleIcons: value })}
        />
      </SettingsGroup>

      {width >= 1024 && (
        <SettingsGroup title="Layout">
          <SettingsSwitchRow
            title="Show member list"
            description="Display the member sidebar in channels."
            value={showMemberList}
            onValueChange={(value) => update({ showMemberList: value })}
          />
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
