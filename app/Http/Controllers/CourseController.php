
<?php
namespace App\Http\Controllers;

use App\Models\Course;
use Illuminate\Http\Request;

class CourseController extends Controller
{
    public function index() {
        $courses = Course::withCount(['pages','quizzes'])->get();
        return view('courses.index', compact('courses'));
    }

    public function show(Course $id) {
        return view('courses.show', ['course'=>$id->load('pages','quizzes.items')]);
    }
}
