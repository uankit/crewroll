import type { ApiMediaObjectStore, WorkerMediaObjectDeletionStore } from "../storage/ports.js";

declare const apiStore: ApiMediaObjectStore;
declare const deletionStore: WorkerMediaObjectDeletionStore;

apiStore.createPutUrl;
apiStore.createGetUrl;
apiStore.head;
// @ts-expect-error API request code cannot delete storage objects.
apiStore.deleteObjects;

deletionStore.deleteObjects;
// @ts-expect-error Worker deletion code cannot mint presigned URLs.
deletionStore.createPutUrl;
// @ts-expect-error Worker deletion code cannot inspect object metadata.
deletionStore.head;
