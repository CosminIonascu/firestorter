// @flow
import { observable, transaction, reaction } from 'mobx';
import { enhancedObservable } from './enhancedObservable';
import { getFirestore, verifyMode } from './init';
import Document from './Document';

import type {
	Query,
	QuerySnapshot,
	DocumentSnapshot,
	CollectionReference
} from 'firebase/firestore';

let fetchingDeprecationWarningCount = 0;

// * @param {Number} [options.limit] Maximum number of documents to fetch (see `Collection.limit`)

/**
 * The Collection class lays at the heart of `firestorter`.
 * It represents a collection in Firestore and its queried data. It is
 * observable so that it can be efficiently linked to a React Component
 * using `mobx-react`'s `observer` pattern.
 *
 * Collection supports three modes of real-time updating:
 * - "off" (real-time updating is turned off)
 * - "on" (real-time updating is permanently turned on)
 * - "auto" (real-time updating is enabled on demand) (default)
 *
 * The "auto" mode ensures that Collection only communicates with
 * the firestore back-end whever the Collection is actually
 * rendered by a Component. This prevents unneccesary background
 * updates and leads to the best possible performance.
 *
 * When real-time updates are enabled, data is automatically fetched
 * from Firestore whenever it changes in the back-end (using `onSnapshot`).
 * This enables almost magical instant updates. When data is changed,
 * only those documents are updated that have actually changed. Document
 * objects are re-used where possible, and just their data is updated.
 * The same is true for the `docs` property. If no documents where
 * added, removed, re-ordered, then the `docs` property itself will not
 * change.
 *
 * Alternatively, you can keep real-time updates turned off and fetch
 * manually. This will update the Collection as efficiently as possible.
 * If nothing has changed on the back-end, no new Documents would be
 * created or modified.
 *
 * @param {Object} [options] Configuration options
 * @param
 * @param {Function|Query} [options.query] See `Collection.query`
 * @param {String} [options.mode] See `Collection.mode`
 * @param {String} [options.DocumentClass] Document classes to create (must be inherited from Document)
 * @param {Bool} [options.minimizeUpdates] Enables additional algorithms to reduces updates to your app (e.g. when snapshots are received in rapid succession)
 * @param {Bool} [options.debug] Enables debug logging
 * @param {String} [options.debugName] Name to use when debug logging is enabled
 *
 * @example
 * import {Collection} from 'firestorter';
 *
 * // Create a collection using path (preferred)
 * const col = new Collection('artists/Metallica/albums');
 *
 * // Create a collection using a reference
 * const col2 = new Collection(firebase.firestore().collection('todos'));
 *
 * // Create a collection and permanently start real-time updating
 * const col2 = new Collection('artists', {
 *   mode: 'on'
 * });
 *
 * // Create a collection with a query on it
 * const col3 = new Collection('artists', {
 *   query: (ref) => ref.orderBy('name', 'asc')
 * });
 *
 * @example
 * // In manual mode, just call `fetch` explicitely
 * const col = new Collection('albums');
 * col.fetch().then((collection) => {
 *	 collection.docs.forEach((doc) => console.log(doc));
 * });
 *
 * // Yo can use the `isLoading` property to see whether a fetch
 * // is in progress
 * console.log(col.isLoading);
 */
class Collection {
	static EMPTY_OPTIONS = {};

	_source: any;
	_refDisposer: any;
	_sourceCache: any;
	_sourceCacheRef: any;
	_docLookup: { [string]: Document };
	_ref: any;
	_query: any;
	_queryRef: any;
	_activeRef: any;
	_mode: any;
	_fetching: any;
	_docs: any;
	_documentClass: any;
	_onSnapshotUnsubscribe: any;
	_observedRefCount: number;
	_debug: boolean;
	_debugName: ?string;
	_minimizeUpdates: boolean;
	// _limit: any;
	// _cursor: any;

	constructor(
		source: CollectionReference | string | (() => string | void),
		options: any
	) {
		const {
			query,
			DocumentClass = Document,
			mode,
			// limit,
			debug,
			debugName,
			minimizeUpdates = false,
			initialLocalSnapshotDetectTime = 50,
			initialLocalSnapshotDebounceTime = 1000
		} =
			options || Collection.EMPTY_OPTIONS;
		this._documentClass = DocumentClass;
		this._debug = debug || false;
		this._debugName = debugName;
		this._minimizeUpdates = minimizeUpdates;
		this._initialLocalSnapshotDetectTime = initialLocalSnapshotDetectTime;
		this._initialLocalSnapshotDebounceTime = initialLocalSnapshotDebounceTime;
		this._docLookup = {};
		this._observedRefCount = 0;
		this._source = source;
		this._ref = observable.box(undefined);
		this._query = query;
		this._queryRef = observable.box(undefined);
		// this._limit = observable.box(limit || undefined);
		// this._cursor = observable.box(undefined);
		this._mode = observable.box(verifyMode(mode || 'auto'));
		this._fetching = observable.box(false);
		this._docs = enhancedObservable([], this);
		this._updateRealtimeUpdates(true, true);
	}

	/**
	 * Array of all the documents that have been fetched
	 * from firestore.
	 *
	 * @example
	 * collection.docs.forEach((doc) => {
	 *   console.log(doc.data);
	 * });
	 */
	get docs(): Array<Document> {
		return this._docs;
	}

	/**
	 * Firestore collection reference.
	 *
	 * Use this property to get or set the collection
	 * reference. When set, a fetch to the new collection
	 * is performed.
	 *
	 * Alternatively, you can also use `path` to change the
	 * reference in more a readable way.
	 *
	 * @example
	 * const col = new Collection(firebase.firestore().collection('albums/splinter/tracks'));
	 * ...
	 * // Switch to another collection
	 * col.ref = firebase.firestore().collection('albums/americana/tracks');
	 */
	get ref(): ?CollectionReference {
		let ref = this._ref.get();
		if (!this._refDisposer) {
			const newRef = this._resolveRef(this._source);
			if (ref !== newRef) {
				ref = newRef;
				this._ref.set(newRef);
			}
		}
		return ref;
	}
	set ref(ref: ?CollectionReference) {
		this.source = ref;
	}

	/**
	 * Id of the Firestore collection (e.g. 'tracks').
	 *
	 * To get the full-path of the collection, use `path`.
	 */
	get id(): ?string {
		const ref = this.ref;
		return ref ? ref.id : undefined;
	}

	/**
	 * Path of the collection (e.g. 'albums/blackAlbum/tracks').
	 *
	 * Use this property to switch to another collection in
	 * the back-end. Effectively, it is a more compact
	 * and readable way of setting a new ref.
	 *
	 * @example
	 * const col = new Collection('artists/Metallica/albums');
	 * ...
	 * // Switch to another collection in the back-end
	 * col.path = 'artists/EaglesOfDeathMetal/albums';
	 */
	get path(): ?string {
		let ref = this.ref;
		if (!ref) return undefined;
		let path = ref.id;
		while (ref.parent) {
			path = ref.parent.id + '/' + path;
			ref = ref.parent;
		}
		return path;
	}
	set path(collectionPath: ?string) {
		this.source = collectionPath;
	}

	/**
	 * @private
	 */
	get source(): ?any {
		return this._source.get();
	}
	set source(source: ?any) {
		if (this._source === source) return;
		transaction(() => {
			this._source = source;

			// Stop any reactions
			if (this._refDisposer) {
				this._refDisposer();
				this._refDisposer = undefined;
			}

			// Update real-time updating
			this._updateRealtimeUpdates(true);
		});
	}

	/**
	 * Use this property to set any order-by, where,
	 * limit or start/end criteria. When set, that query
	 * is used to retrieve any data. When cleared, the collection
	 * reference is used.
	 *
	 * The query can be either a Function of the form
	 * `(CollectionReference) => Query` (preferred), or a direct
	 * Firestore Query object.
	 *
	 * @example
	 * const todos = new Collection('todos');
	 *
	 * // Sort the collection
	 * todos.query = (ref) => ref.orderBy('text', 'asc');
	 *
	 * // Order, filter & limit
	 * todos.query = (ref) => ref.where('finished', '==', false).orderBy('finished', 'asc').limit(20);
	 *
	 * // Clear the query, will cause whole collection to be fetched
	 * todos.query = undefined;
	 */
	get query(): ?((CollectionReference) => Query) | Query {
		return this._query;
	}
	set query(query?: ((CollectionReference) => Query) | Query) {
		if (this._query === query) return;
		transaction(() => {
			this._query = query;

			// Stop any reactions
			if (this._refDisposer) {
				this._refDisposer();
				this._refDisposer = undefined;
			}

			// Update real-time updating
			this._updateRealtimeUpdates(undefined, true);
		});
	}

	/**
	 * @private
	 */
	get queryRef() {
		return this._queryRef.get();
	}

	/**
	 * Real-time updating mode.
	 *
	 * Can be set to any of the following values:
	 * - "auto" (enables real-time updating when the collection is observed)
	 * - "off" (no real-time updating, you need to call fetch explicitly)
	 * - "on" (real-time updating is permanently enabled)
	 */
	get mode(): string {
		return this._mode.get();
	}
	set mode(mode: string) {
		if (this._mode.get() === mode) return;
		verifyMode(mode);
		transaction(() => {
			this._mode.set(mode);
			this._updateRealtimeUpdates();
		});
	}

	/**
	 * Returns true when the Collection is actively listening
	 * for changes in the firestore back-end.
	 */
	get isActive(): boolean {
		return !!this._onSnapshotUnsubscribe;
	}

	/**
	 * @private
	 */
	get active(): boolean {
		console.warn(
			'Collection.active has been renamed `isActive`, please update as the method will be removed in the near future'
		);
		return this.isActive;
	}

	/**
	 * @private
	 */
	_resolveRef(source) {
		if (this._sourceCache === source) {
			return this._sourceCacheRef;
		}
		let ref;
		if (typeof source === 'string') {
			ref = getFirestore().collection(source);
		} else if (typeof source === 'function') {
			ref = this._resolveRef(source());
			return ref; // don't set cache in this case
		} else {
			ref = source;
		}
		this._sourceCache = source;
		this._sourceCacheRef = ref;
		return ref;
	}

	/**
	 * @private
	 */
	_resolveQuery(collectionRef, query) {
		let ref = query;
		if (typeof query === 'function') {
			ref = query(collectionRef);
		}

		// Apply pagination cursor
		/* const cursor = this._cursor.get();
		if (cursor) {
			ref = ref || collectionRef;
			switch (cursor.type) {
				case 'startAfter': ref = ref.startAfter(cursor.value); break;
				case 'startAt': ref = ref.startAt(cursor.value); break;
				case 'endBefore': ref = ref.endBefore(cursor.value); break;
				case 'endAt': ref = ref.endAt(cursor.value); break;
			}
		}

		// Apply fetch limit
		const limit = this.limit;
		if (limit) {
			ref = ref || collectionRef;
			ref = ref.limit(limit);
		}*/
		return ref;
	}

	/**
	 * Fetches new data from firestore. Use this to manually fetch
	 * new data when `mode` is set to 'off'.
	 *
	 * @example
	 * const col = new Collection('albums', 'off');
	 * col.fetch().then(({docs}) => {
	 *   docs.forEach(doc => console.log(doc));
	 * });
	 */
	fetch(): Promise<Collection> {
		return new Promise((resolve, reject) => {
			if (this.isActive)
				return reject(
					new Error('Should not call fetch when real-time updating is active')
				);
			if (this._fetching.get())
				return reject(new Error('Fetch already in progress'));

			const colRef = this._resolveRef(this._source);
			const queryRef = this._resolveQuery(colRef, this._query);
			const ref = queryRef || colRef;
			if (!ref) {
				return reject(new Error('No ref, path or query set on Collection'));
			}
			this._ready(false);
			this._fetching.set(true);
			ref.get().then(
				snapshot => {
					transaction(() => {
						this._fetching.set(false);
						this._updateFromSnapshot(snapshot);
					});
					this._ready(true);
					resolve(this);
				},
				err => {
					this._fetching.set(false);
					this._ready(true);
					reject(err);
				}
			);
		});
	}

	/**
	 * True when new data is being loaded.
	 *
	 * Fetches are performed in these cases:
	 *
	 * - When real-time updating is started
	 * - When a different `ref` or `path` is set
	 * - When a `query` is set or cleared
	 * - When `fetch` is explicitely called
	 *
	 * @example
	 * const col = new Collection('albums', {mode: 'off'});
	 * console.log(col.isLoading);  // false
	 * col.fetch();                 // start fetch
	 * console.log(col.isLoading);  // true
	 * await col.ready();           // wait for fetch to complete
	 * console.log(col.isLoading);  // false
	 *
	 * @example
	 * const col = new Collection('albums');
	 * console.log(col.isLoading);  // false
	 * const dispose = autorun(() => {
	 *   console.log(col.docs);     // start observing collection data
	 * });
	 * console.log(col.isLoading);  // true
	 * ...
	 * dispose();                   // stop observing collection data
	 * console.log(col.isLoading);  // false
	 */
	get isLoading(): boolean {
		this._docs.length; // access data
		return this._fetching.get();
	}

	/**
	 * @private
	 */
	get fetching(): boolean {
		if ((fetchingDeprecationWarningCount % 100) === 0) {
			console.warn(
				'Collection.fetching has been deprecated and will be removed soon, please use `isLoading` instead'
			);
		}
		fetchingDeprecationWarningCount++;
		return this._fetching.get();
	}

	/**
	 * Promise that is resolved when the Collection has
	 * finished fetching its (initial) documents.
	 *
	 * Use this method to for instance wait for
	 * the initial snapshot update to complete, or to wait
	 * for fresh data after changing the path/ref.
	 *
	 * @example
	 * const col = new Collection('albums', {mode: 'on'});
	 * await col.ready();
	 * console.log('albums: ', col.docs);
	 *
	 * @example
	 * const col = new Collection('artists/FooFighters/albums', {mode: 'on'});
	 * await col.ready();
	 * ...
	 * // Changing the path causes a new snapshot update
	 * col.path = 'artists/TheOffspring/albums';
	 * await col.ready();
	 * console.log('albums: ', col.docs);
	 */
	ready(): Promise<void> {
		this._readyPromise = this._readyPromise || Promise.resolve(true);
		return this._readyPromise;
	}

	/**
	 * @private
	 */
	_ready(complete) {
		if (complete) {
			const readyResolve = this._readyResolve;
			if (readyResolve) {
				this._readyResolve = undefined;
				readyResolve(true);
			}
		} else if (!this._readyResolve) {
			this._readyPromise = new Promise(resolve => {
				this._readyResolve = resolve;
			});
		}
	}

	/**
	 * Add a new document to this collection with the specified
	 * data, assigning it a document ID automatically.
	 *
	 * @example
	 * const doc = await collection.add({
	 *   finished: false,
	 *   text: 'New todo',
	 *   options: {
	 *     highPrio: true
	 *   }
	 * });
	 */
	add(data: any): Promise<Document> {
		return new Promise((resolve, reject) => {
			const ref = this.ref;
			if (!ref) return reject(new Error('No valid collection reference'));

			// Validate schema
			try {
				new this._documentClass(undefined, {
					snapshot: {
						data: () => data
					}
				});
			}
			catch (err) {
				return reject(err);
			}

			// Add to firestore
			ref.add(data).then(ref => {
				ref.get().then(snapshot => {
					try {
						const doc = new this._documentClass(snapshot.ref, {
							snapshot: snapshot
						});
						resolve(doc);
					} catch (err) {
						reject(err);
					}
				}, reject);
			}, reject);
		});
	}

	/**
	 * Deletes all the documents in the collection or query.
	 *
	 * TODO - Not implemented yet
	 */
	deleteAll(): Promise<void> {
		const ref = this.ref;
		if (!ref) throw new Error('No valid collection reference');
		// TODO
		return Promise.resolve(undefined);
	}

	/**
	 * Limit used for query pagination.
	 */
	/* get limit(): ?number {
		return this._limit.get();
	}
	set limit(val: ?number) {
		this._limit.set(val || undefined);
	}*/

	/**
	 * Paginates to the start of the collection,
	 * resetting any pagination cursor that exists.
	 */
	/* paginateToStart() {
		this._cursor.set(undefined);
	}*/

	/**
	 * Paginates to the next page. This sets the cursor
	 * to `startAfter` the last document.
	 *
	 * @return {Boolean} False in case pagination was not possible
	 */
	/* paginateNext(): boolean {
		if (!this.canPaginateNext) return false;
		this._cursor.set({
			type: 'startAfter',
			value: this.docs[this.docs.length - 1].ref
		});
		return true;
	}*/

	/**
	 * Paginates to the previous page. This sets the cursor
	 * to `endBefore` the first document in `docs`.
	 *
	 * @return {Boolean} False in case pagination was not possible
	 */
	/* paginatePrevious(): boolean {
		if (!this.canPaginatePrevious) return false;
		if (!this.docs.length) {
			this._cursor.set(undefined);
			return true;
		}
		this._cursor.set({
			type: 'endBefore',
			value: this.docs[0].ref
		});
		return true;
	}

	get canPaginateNext(): boolean {
		if (!this.limit) return false;
		return this.docs.length >= this.limit;
	}

	get canPaginatePrevious(): boolean {
		if (!this.limit) return false;
		return this._cursor.get() ? true : false;
	}*/

	/**
	 * Called whenever a property of this class becomes observed.
	 * @private
	 */
	addObserverRef(): number {
		if (this._debug)
			console.debug(
				`${this.debugName} - addRef (${this._observedRefCount + 1})`
			);
		const res = ++this._observedRefCount;
		if (res === 1) {
			transaction(() => {
				this._updateRealtimeUpdates();
			});
		}
		return res;
	}

	/**
	 * Called whenever a property of this class becomes un-observed.
	 * @private
	 */
	releaseObserverRef(): number {
		if (this._debug)
			console.debug(
				`${this.debugName} - releaseRef (${this._observedRefCount - 1})`
			);
		const res = --this._observedRefCount;
		if (!res) {
			transaction(() => {
				this._updateRealtimeUpdates();
			});
		}
		return res;
	}

	/**
	 * @private
	 */
	_onSnapshot(snapshot: QuerySnapshot) {

		// Firestore sometimes returns multiple snapshots initially.
		// The first one containing cached results, followed by a second
		// snapshot which was fetched from the cloud.
		if (this._initialLocalSnapshotDebounceTimer) {
			clearTimeout(this._initialLocalSnapshotDebounceTimer);
			this._initialLocalSnapshotDebounceTimer = undefined;
			if (this._debug)
				console.debug(
					`${this.debugName} - cancelling initial debounced snapshot, because a newer snapshot has been received`
				);
		}
		if (this._minimizeUpdates) {
			const timeElapsed = Date.now() - this._initialLocalSnapshotStartTime;
			this._initialLocalSnapshotStartTime = 0;
			if ((timeElapsed >= 0) && (timeElapsed < this._initialLocalSnapshotDetectTime)) {
				if (this._debug)
					console.debug(
						`${this.debugName} - local snapshot detected (${timeElapsed}ms < ${this._initialLocalSnapshotDetectTime}ms threshold), debouncing ${this._initialLocalSnapshotDebounceTime} msec...`
					);
				this._initialLocalSnapshotDebounceTimer = setTimeout(() => {
					this._initialLocalSnapshotDebounceTimer = undefined;
					this._onSnapshot(snapshot);
				}, this._initialLocalSnapshotDebounceTime);
				return;
			}
		}

		// Process snapshot
		transaction(() => {
			if (this._debug) console.debug(`${this.debugName} - onSnapshot`);
			this._fetching.set(false);
			this._updateFromSnapshot(snapshot);
			this._ready(true);
		});
	}

	/**
	 * @private
	 */
	_updateFromSnapshot(snapshot: QuerySnapshot) {
		const newDocs = [];
		snapshot.docs.forEach((snapshot: DocumentSnapshot) => {
			let doc = this._docLookup[snapshot.id];
			try {
				if (doc) {
					doc._updateFromSnapshot(snapshot);
				} else {
					doc = new this._documentClass(snapshot.ref, {
						snapshot: snapshot
					});
					this._docLookup[doc.id] = doc;
				}
				doc._collectionRefCount++;
				newDocs.push(doc);
			} catch (err) {
				console.error(err.message);
			}
		});
		this._docs.forEach(doc => {
			if (!--doc._collectionRefCount) {
				delete this._docLookup[doc.id || ''];
			}
		});

		if (this._docs.length !== newDocs.length) {
			this._docs.replace(newDocs);
		} else {
			for (let i = 0, n = newDocs.length; i < n; i++) {
				if (newDocs[i] !== this._docs[i]) {
					this._docs.replace(newDocs);
					break;
				}
			}
		}
	}

	/**
	 * @private
	 */
	_updateRealtimeUpdates(updateSourceRef, updateQueryRef) {
		let newActive = false;
		const active = !!this._onSnapshotUnsubscribe;
		switch (this._mode.get()) {
			case 'auto':
				newActive = !!this._observedRefCount;
				break;
			case 'off':
				newActive = false;
				break;
			case 'on':
				newActive = true;
				break;
		}

		// Update source & query ref if needed
		if (newActive && !active) {
			updateSourceRef = true;
			updateQueryRef = true;
		}
		if (updateSourceRef) {
			this._ref.set(this._resolveRef(this._source));
		}
		if (updateQueryRef) {
			this._queryRef.set(this._resolveQuery(this._ref.get(), this._query));
		}

		// Upon de-activation, stop any observed reactions or
		// snapshot listeners.
		if (!newActive) {
			if (this._refDisposer) {
				this._refDisposer();
				this._refDisposer = undefined;
			}
			this._activeRef = undefined;
			if (this._onSnapshotUnsubscribe) {
				if (this._debug)
					console.debug(
						`${this.debugName} - stop (${this._mode.get()}:${
							this._observedRefCount
						})`
					);
				this._onSnapshotUnsubscribe();
				this._onSnapshotUnsubscribe = undefined;
				if (this._fetching.get()) {
					this._fetching.set(false);
				}
				this._ready(true);
			}
			return;
		}

		// Start listening for ref-changes
		if (!this._refDisposer) {
			let initialSourceRef = this._ref.get();
			let initialQueryRef = this._queryRef.get();
			this._refDisposer = reaction(
				() => {
					let sourceRef = this._resolveRef(this._source);
					let queryRef = this._resolveQuery(sourceRef, this._query);
					if (initialSourceRef) {
						sourceRef = initialSourceRef;
						queryRef = initialQueryRef;
						initialSourceRef = undefined;
						initialQueryRef = undefined;
					}
					return {
						sourceRef,
						queryRef
					};
				},
				({sourceRef, queryRef}) => {
					transaction(() => {
						if ((this._ref.get() !== sourceRef) || (this._queryRef.get() !== queryRef)) {
							this._ref.set(sourceRef);
							this._queryRef.set(queryRef);
							this._updateRealtimeUpdates();
						}
					});
				}
			);
		}

		// Resolve ref and check whether it has changed
		const ref = this._queryRef.get() || this._ref.get();
		if (this._activeRef === ref) return;
		this._activeRef = ref;

		// Stop any existing listener
		if (this._onSnapshotUnsubscribe) {
			this._onSnapshotUnsubscribe();
			this._onSnapshotUnsubscribe = undefined;
		}

		// Check whether any ref exists
		if (!ref) return;

		// Start listener
		if (this._debug)
			console.debug(
				`${this.debugName} - ${
					active ? 're-' : ''
				}start (${this._mode.get()}:${this._observedRefCount})`
			);
		this._ready(false);
		this._fetching.set(true);
		this._initialLocalSnapshotStartTime = Date.now();
		this._onSnapshotUnsubscribe = ref.onSnapshot(
			snapshot => this._onSnapshot(snapshot)
		);
	}

	/**
	 * @private
	 */
	get debugName(): string {
		return `${this._debugName || this.constructor.name} (${this.path})`;
	}
}

export default Collection;
