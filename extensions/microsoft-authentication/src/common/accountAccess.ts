/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Event, EventEmitter, SecretStorage } from 'vscode';
import { AccountInfo } from '@azure/msal-node';

interface IAccountAccess {
	onDidAccountAccessChange: Event<void>;
	isAllowedAccess(account: AccountInfo): boolean;
	setAllowedAccess(account: AccountInfo, allowed: boolean): void;
}

export class ScopedAccountAccess implements IAccountAccess {
	private readonly _onDidAccountAccessChangeEmitter = new EventEmitter<void>();
	readonly onDidAccountAccessChange = this._onDidAccountAccessChangeEmitter.event;

	private readonly _accountAccessSecretStorage: AccountAccessSecretStorage;

	private value = new Array<string>();

	constructor(
		private readonly _secretStorage: SecretStorage,
		private readonly _cloudName: string,
		private readonly _clientId: string,
		private readonly _authority: string
	) {
		this._accountAccessSecretStorage = new AccountAccessSecretStorage(this._secretStorage, this._cloudName, this._clientId, this._authority);
		this._accountAccessSecretStorage.onDidChange(() => this.update());
	}

	initialize() {
		return this.update();
	}

	isAllowedAccess(account: AccountInfo): boolean {
		return this.value.includes(account.homeAccountId);
	}

	async setAllowedAccess(account: AccountInfo, allowed: boolean): Promise<void> {
		if (allowed) {
			if (this.value.includes(account.homeAccountId)) {
				return;
			}
			await this._accountAccessSecretStorage.store([...this.value, account.homeAccountId]);
			return;
		}
		const newValue = this.value.filter(id => id !== account.homeAccountId);
		if (newValue.length === this.value.length) {
			return;
		}
		if (newValue.length) {
			await this._accountAccessSecretStorage.store(newValue);
		} else {
			await this._accountAccessSecretStorage.delete();
		}
	}

	private async update() {
		const current = new Set(this.value);
		const value = await this._accountAccessSecretStorage.get();

		this.value = value ?? [];
		if (current.size !== this.value.length || !this.value.every(id => current.has(id))) {
			this._onDidAccountAccessChangeEmitter.fire();
		}
	}
}

export class AccountAccessSecretStorage {
	private _disposable: Disposable;

	private readonly _onDidChangeEmitter = new EventEmitter<void>;
	readonly onDidChange: Event<void> = this._onDidChangeEmitter.event;

	// TODO@TylerLeonhardt: Remove legacy key in next version
	private readonly _legacyKey = `accounts-${this._cloudName}-${this._clientId}-${this._authority}`;
	private readonly _key = `accounts-${this._cloudName}`;

	constructor(
		private readonly _secretStorage: SecretStorage,
		private readonly _cloudName: string,
		private readonly _clientId: string,
		private readonly _authority: string
	) {
		this._disposable = Disposable.from(
			this._onDidChangeEmitter,
			this._secretStorage.onDidChange(e => {
				if (e.key === this._key || e.key === this._legacyKey) {
					this._onDidChangeEmitter.fire();
				}
			})
		);
	}

	async get(): Promise<string[] | undefined> {
		const value = await this._secretStorage.get(this._key);
		if (value) {
			return JSON.parse(value);
		}
		// TODO@TylerLeonhardt: Remove legacy fallback in next version
		const legacyValue = await this._secretStorage.get(this._legacyKey);
		if (legacyValue) {
			// Update the new store with the legacy value
			const parsedValue = JSON.parse(legacyValue);
			await this._secretStorage.store(this._key, legacyValue);
			return parsedValue;
		}
		return undefined;
	}

	async store(value: string[]): Promise<void> {
		const stringified = JSON.stringify(value);
		// TODO@TylerLeonhardt: Remove legacy storage in next version
		await Promise.all([
			this._secretStorage.store(this._key, stringified),
			this._secretStorage.store(this._legacyKey, stringified)
		]);
	}

	async delete(): Promise<void> {
		// TODO@TylerLeonhardt: Remove legacy deletion in next version
		await Promise.all([
			this._secretStorage.delete(this._key),
			this._secretStorage.delete(this._legacyKey)
		]);
	}

	dispose() {
		this._disposable.dispose();
	}
}
