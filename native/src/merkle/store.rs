use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::types::{MerkleError, MerkleNode, MerkleNodeKind, MerkleResult, MerkleSnapshot};

pub fn save_snapshot(conn: &mut Connection, snapshot: &MerkleSnapshot) -> MerkleResult<()> {
    let tx = conn.transaction()?;
    tx.execute(
        r#"
        INSERT INTO merkle_snapshots (branch, root_hash, created_at, updated_at)
        VALUES (?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
        ON CONFLICT(branch) DO UPDATE SET
            root_hash = excluded.root_hash,
            updated_at = excluded.updated_at
        "#,
        params![snapshot.branch, snapshot.root_hash],
    )?;

    tx.execute(
        "DELETE FROM merkle_nodes WHERE branch = ?",
        params![snapshot.branch],
    )?;

    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO merkle_nodes (branch, path, parent_path, node_kind, node_hash, size_bytes)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )?;

        for node in snapshot.nodes.values() {
            stmt.execute(params![
                snapshot.branch,
                node.path,
                node.parent_path,
                node.kind.as_str(),
                node.hash,
                node.size_bytes.map(|value| value as i64),
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

pub fn load_snapshot(conn: &Connection, branch: &str) -> MerkleResult<Option<MerkleSnapshot>> {
    let snapshot_row: Option<(String, String)> = conn
        .query_row(
            "SELECT branch, root_hash FROM merkle_snapshots WHERE branch = ?",
            params![branch],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let Some((branch_name, root_hash)) = snapshot_row else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        r#"
        SELECT path, parent_path, node_kind, node_hash, size_bytes
        FROM merkle_nodes
        WHERE branch = ?
        ORDER BY path
        "#,
    )?;

    let mut nodes = BTreeMap::new();
    let rows = stmt.query_map(params![branch], |row| {
        let node_kind: String = row.get(2)?;
        let size_bytes: Option<i64> = row.get(4)?;
        Ok(MerkleNode {
            path: row.get(0)?,
            parent_path: row.get(1)?,
            kind: MerkleNodeKind::from_str(&node_kind).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
            hash: row.get(3)?,
            size_bytes: size_bytes.map(|value| value as u64),
        })
    })?;

    for row in rows {
        let node = row?;
        nodes.insert(node.path.clone(), node);
    }

    let root = nodes.get("").ok_or_else(|| {
        MerkleError::InvalidSnapshot(format!(
            "snapshot for branch '{}' is missing root node",
            branch
        ))
    })?;

    if root.hash != root_hash {
        return Err(MerkleError::InvalidSnapshot(format!(
            "root hash mismatch for branch '{}': snapshot={}, nodes={}",
            branch, root_hash, root.hash
        )));
    }

    Ok(Some(MerkleSnapshot {
        branch: branch_name,
        root_hash,
        nodes,
    }))
}

pub fn delete_snapshot(conn: &Connection, branch: &str) -> MerkleResult<bool> {
    let deleted = conn.execute(
        "DELETE FROM merkle_snapshots WHERE branch = ?",
        params![branch],
    )?;
    Ok(deleted > 0)
}

pub fn clear_all_snapshots(conn: &Connection) -> MerkleResult<()> {
    conn.execute("DELETE FROM merkle_nodes", [])?;
    conn.execute("DELETE FROM merkle_snapshots", [])?;
    Ok(())
}
