import React, { useState } from 'react';
import { importIdentity } from '../core/src/keystore';

const IdentityCard = () => {
  const [importing, setImporting] = useState(false);
  const [secret, setSecret] = useState('');

  const handleImport = async () => {
    try {
      const publicIdentity = importIdentity(secret);
      // Update the UI with the new identity
    } catch (error) {
      console.error(error.message);
    }
  };

  return (
    <div>
      {importing ? (
        <div>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Enter your secret"
          />
          <button onClick={handleImport}>Import</button>
        </div>
      ) : (
        <div>
          <button onClick={() => setImporting(true)}>Import an existing key</button>
        </div>
      )}
    </div>
  );
};

export default IdentityCard;