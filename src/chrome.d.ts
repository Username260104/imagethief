declare namespace chrome {
  namespace action {
    const onClicked: {
      addListener(callback: (tab: tabs.Tab) => void): void;
    };
  }

  namespace commands {
    const onCommand: {
      addListener(callback: (command: string, tab?: tabs.Tab) => void): void;
    };
  }

  namespace runtime {
    const id: string;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ): void;
    };
    function getURL(path: string): string;
    function sendMessage(message: unknown): Promise<unknown>;

    type MessageSender = {
      tab?: tabs.Tab;
      frameId?: number;
      id?: string;
      url?: string;
    };
  }

  namespace scripting {
    function executeScript(details: {
      target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
      files: string[];
    }): Promise<unknown[]>;
  }

  namespace storage {
    const session: {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  }

  namespace tabs {
    type Tab = {
      id?: number;
      url?: string;
      active?: boolean;
      windowId?: number;
    };

    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function create(createProperties: {
      url: string;
      active?: boolean;
      openerTabId?: number;
    }): Promise<Tab>;
  }
}
