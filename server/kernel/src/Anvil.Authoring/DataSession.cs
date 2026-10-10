namespace Anvil.Authoring;

/// <summary>Per-request data access. Inject this dependency into source methods; the native action receives the business arguments only.
/// Persisted enum properties are native catalog foreign keys: writes accept declared enum members;
/// numeric enum values outside the catalog remain valid in source logic but fail persistence validation.</summary>
public interface IDataSession
{
    /// <summary>Query detached records. Standard LINQ expressions describe the query; reads do not implicitly save later changes.</summary>
    IQueryable<T> Query<T>() where T : class;
    /// <summary>Create a record and return its generated identity. The supplied object is not mutated.</summary>
    Id<T> Insert<T>(T record) where T : class;
    /// <summary>Replace the persisted fields of a record identified by its Id; fail when that record does not exist.</summary>
    void Update<T>(T record) where T : class;
    /// <summary>Delete an existing record; foreign key constraints remain enforced.</summary>
    void Delete<T>(Id<T> id) where T : class;
}
