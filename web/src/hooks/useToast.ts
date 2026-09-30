import { useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import type { Toast } from '../store/appStore';

export function useToast(): (level: Toast['level'], text: string) => void {
  return useCallback((level: Toast['level'], text: string) => {
    useAppStore.getState().toast(level, text);
  }, []);
}
