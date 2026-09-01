import * as Updates from "expo-updates";
import { useEffect } from "react";

export function useAutoUpdate() {
  useEffect(() => {
    if (!Updates.isEnabled) return;

    (async () => {
      try {
        const check = await Updates.checkForUpdateAsync();
        if (!check.isAvailable) return;

        const result = await Updates.fetchUpdateAsync();
        if (result.isNew) {
          await Updates.reloadAsync();
        }
      } catch (err) {
        console.error("[updates]", err);
      }
    })();
  }, []);
}
