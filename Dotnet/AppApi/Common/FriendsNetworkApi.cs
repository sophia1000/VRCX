using System.Threading.Tasks;
using VRCX.FriendsNetwork;

namespace VRCX;

public partial class AppApi
{
    // Data is loaded on demand; other pages do not scan history or create cache
    // tables. Cef and Electron use the same native request boundary.
    private static readonly FriendsNetworkService friendsNetwork = new(() => SQLite.Instance.DatabasePath);

    public Task<string> FriendsNetworkGraph(string settingsJson) => friendsNetwork.GraphAsync(settingsJson);
    public Task<string> FriendsNetworkRebuild(string settingsJson) => friendsNetwork.GraphAsync(settingsJson, rebuild: true);
    public Task<string> FriendsNetworkPeople() => friendsNetwork.PeopleAsync();
    public string FriendsNetworkStatus() => friendsNetwork.Status();
    public void FriendsNetworkCancel() => friendsNetwork.Cancel();
    internal static void DisposeFriendsNetwork() => friendsNetwork.Dispose();
}
