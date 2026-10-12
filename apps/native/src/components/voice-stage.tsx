// Port of apps/frontend/src/lib/components/voice-stage.svelte
import {
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { VoiceTileView } from '@/components/voice-tile';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { fitTiles, type VoiceTile } from '@/lib/voice-layout';

const GAP = 8;
const SIDE_STRIP = 160;
const BOTTOM_STRIP = 96;

type Size = { width: number; height: number };

export function VoiceStage({
  tiles,
  spotlightKey,
  onFocus,
  onExitSpotlight,
}: {
  tiles: VoiceTile[];
  spotlightKey: string | null;
  // Tapping a grid or filmstrip tile spotlights it, Discord-style.
  onFocus: (key: string) => void;
  // Tapping the spotlighted tile itself goes back to the grid.
  onExitSpotlight: () => void;
}) {
  const circleIcons = useSettings((s) => s.circleIcons);
  // Measured on the padding-free wrapper below, so this is exactly the area tiles may use.
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [spotlightSize, setSpotlightSize] = useState<Size>({ width: 0, height: 0 });
  // Whether the filmstrip of everyone else is collapsed away, leaving the spotlight full size.
  const [stripCollapsed, setStripCollapsed] = useState(false);

  const spotlight = tiles.find((tile) => tile.key === spotlightKey) ?? null;
  const rest = spotlight ? tiles.filter((tile) => tile.key !== spotlight.key) : tiles;

  // Landscape puts the filmstrip on the side, portrait along the bottom. Driven by the
  // measured stage rather than breakpoints, so phone landscape behaves too.
  const sideStrip = stage.width > stage.height * 1.1;

  // Locked to 16:9 like Discord; narrow stages let tiles flex so they don't shrink to slivers.
  const [minAspect, maxAspect] = stage.width < 640 ? [1, 2] : [16 / 9, 16 / 9];
  const grid = fitTiles(stage.width, stage.height, tiles.length, GAP, minAspect, maxAspect);
  const overflows = grid.rows * (grid.height + GAP) - GAP > stage.height + 1;

  return (
    <View className="min-h-0 min-w-0 flex-1 p-2">
      <View
        className={cn('min-h-0 min-w-0 flex-1', spotlight && sideStrip ? 'flex-row' : 'flex-col')}
        onLayout={(e) => setStage(e.nativeEvent.layout)}
      >
        {spotlight ? (
          <>
            <View
              className="relative min-h-0 min-w-0 flex-1 items-center justify-center"
              onLayout={(e) => setSpotlightSize(e.nativeEvent.layout)}
            >
              <VoiceTileView
                tile={spotlight}
                fitWithin={spotlightSize}
                onSelect={onExitSpotlight}
                ariaLabel="Show grid view"
              />

              {rest.length > 0 && (
                <Pressable
                  className={cn(
                    'absolute z-10 h-7 flex-row items-center gap-1.5 bg-black/60 px-2 active:bg-black/75',
                    sideStrip ? 'right-2 top-2' : 'bottom-2 right-2',
                    circleIcons && 'rounded-full'
                  )}
                  accessibilityLabel={stripCollapsed ? 'Show participants' : 'Hide participants'}
                  accessibilityState={{ expanded: !stripCollapsed }}
                  onPress={() => setStripCollapsed(!stripCollapsed)}
                >
                  <Icon
                    as={
                      sideStrip
                        ? stripCollapsed
                          ? PanelRightOpen
                          : PanelRightClose
                        : stripCollapsed
                          ? PanelBottomOpen
                          : PanelBottomClose
                    }
                    size={14}
                    className="text-white"
                  />
                  {stripCollapsed && (
                    <Text className="text-xs font-medium text-white">{rest.length}</Text>
                  )}
                </Pressable>
              )}
            </View>

            {rest.length > 0 && !stripCollapsed && (
              <ScrollView
                horizontal={!sideStrip}
                className={cn('shrink-0 grow-0', sideStrip ? 'ml-2 w-40' : 'mt-2 h-24')}
                contentContainerClassName="gap-2"
              >
                {rest.map((tile) => (
                  <VoiceTileView
                    key={tile.key}
                    tile={tile}
                    compact
                    width={sideStrip ? SIDE_STRIP : Math.round((BOTTOM_STRIP * 16) / 9)}
                    height={sideStrip ? Math.round((SIDE_STRIP * 9) / 16) : BOTTOM_STRIP}
                    onSelect={() => onFocus(tile.key)}
                  />
                ))}
              </ScrollView>
            )}
          </>
        ) : (
          <ScrollView
            className="min-h-0 min-w-0 flex-1"
            scrollEnabled={overflows}
            contentContainerClassName={cn(
              'flex-row flex-wrap justify-center gap-2',
              overflows ? 'content-start' : 'grow content-center items-center'
            )}
          >
            {tiles.map((tile) => (
              <VoiceTileView
                key={tile.key}
                tile={tile}
                width={grid.width}
                height={grid.height}
                onSelect={() => onFocus(tile.key)}
              />
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
